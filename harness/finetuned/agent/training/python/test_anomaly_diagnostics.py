"""Evidence isolation, bounded volume estimates, synthetic hooks and model signals."""
import contextlib
import io
import json
import shutil
import unittest

import numpy as np

import worker
import test_measurements
from smartlab_trial.anomaly_measurements import volume_curves
from smartlab_trial.measurement import load_evidence


HOOKS = '''
    def diagnostic_features(self, frame):
        assert not frame.attrs, "Evidence leaked through frame attrs"
        return np.array([[float(x[0])] for x in frame.input])
    def score_features(self, features):
        return -np.asarray(features)[:, 0]
    def diagnostic_signals(self, frame):
        assert not frame.attrs, "Evidence leaked through frame attrs"
        x = np.array([float(value[0]) for value in frame.input])
        return {"reconstructionError": x * x, "logLikelihood": -x}
    def diagnostic_challenge(self, frame, context):
        assert not frame.attrs, "Evidence leaked into challenge generator"
        import pandas as pd
        return {"frame": pd.DataFrame({"id": ["synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d"],
                                      "input": [[0], [0.1], [10], [11]]}), "labels": [0, 0, 1, 1]}
'''


class Volume(unittest.TestCase):
    def test_mass_volume_retains_ties_and_is_invariant_to_monotone_score_transform(self):
        observed = np.array([1., 2., 2., 3., 4.])
        reference = np.linspace(0, 5, 101)
        first = volume_curves(observed, reference, 10, "lower_is_anomalous")
        transformed = volume_curves(observed * 5 + 3, reference * 5 + 3, 10, "lower_is_anomalous")
        self.assertEqual([row["volume"] for row in first["massVolume"]], [row["volume"] for row in transformed["massVolume"]])
        self.assertEqual(first["excessMass"], transformed["excessMass"])
        self.assertTrue(all(row["actualMass"] >= row["targetMass"] for row in first["massVolume"]))
        values = [row["value"] for row in first["excessMass"]]
        self.assertTrue(all(a >= b for a, b in zip(values, values[1:])))
        self.assertTrue(all(0 <= x <= 1 for x in values))

    def test_volume_rejects_nonfinite_scores_and_invalid_support(self):
        for observed, support in (([np.nan, 1], 10), ([1, 2], 0), ([1, 2], np.inf)):
            with self.assertRaises(ValueError):
                volume_curves(observed, [1, 2], support, "higher_is_anomalous")


class AnomalyWorker(unittest.TestCase):
    def setUp(self):
        self.fixture = test_measurements.MeasurementWorker()
        self.fixture.setUp()
        self.root = self.fixture.fixture.root
        self.addCleanup(shutil.rmtree, self.root)
        code = test_measurements.PIPELINE.replace("    def fit(self, frame, y=None):", HOOKS + "\n    def fit(self, frame, y=None):")
        code = code.replace('        assert y is None,', '        assert not frame.attrs, "Evidence leaked into fit"\n        assert y is None,')
        (self.root / "solutions/generic.py").write_text(code)

    def document(self, source="agent_provided"):
        document = self.fixture.document("anomaly_detection", targets=False, execution="inductive")
        metadata = json.loads((self.root / "samples.json").read_text())
        path = self.root / "evidence.json"
        path.write_text(json.dumps({"schemaVersion": 1, "labels": [{"id": row["id"], "target": int(row["input"][0] > 1)}
                                                                 for row in metadata["samples"]]}))
        document["measurement"]["evidence"] = {"path": str(path), "source": source}
        return document

    def execute(self, document):
        with contextlib.redirect_stdout(io.StringIO()):
            return worker.execute(document)

    def test_evidence_is_scored_without_entering_fit_and_provenance_does_not_promote(self):
        for source in ("trusted", "agent_provided"):
            document = self.document(source)
            document["inputs"]["outputDir"] = str(self.root / source)
            result = self.execute(document)
            self.assertFalse(result["promotionEligible"])
            measured = result["diagnostics"]["folds"][0]["diagnostics"]["evidence"]
            self.assertEqual(measured["ranking"]["rocAuc"], 1)
            self.assertEqual(measured["predictionMetrics"]["balancedAccuracy"], 1)
            self.assertEqual(measured["proxyEvidence"], source != "trusted")
            self.assertFalse(measured["promotionEvidence"])

    def test_model_signals_challenge_and_volume_run_on_fitted_model_without_extra_fit(self):
        document = self.document()
        document["request"]["diagnostics"] = {
            "modelSignals": {"method": "diagnostic_signals", "compareTrain": True, "units": "fixture units"},
            "challenge": {"method": "diagnostic_challenge"},
            "representation": {"source": "method", "method": "diagnostic_features"},
            "volume": {"bounds": [[0, 6]], "scoreSource": "method", "scoreMethod": "score_features", "uniformSamples": 128}}
        result = self.execute(document)
        measured = result["diagnostics"]["folds"][0]["diagnostics"]
        self.assertTrue(measured["modelSignals"]["trainComparison"]["available"])
        self.assertEqual(measured["challenge"]["ranking"]["rocAuc"], 1)
        self.assertEqual(measured["challenge"]["source"], "synthetic")
        self.assertTrue(measured["volume"]["available"])
        self.assertEqual(measured["volume"]["uniformRows"], 128)
        events = [json.loads(line) for line in (self.root / "generic/events.jsonl").read_text().splitlines()]
        self.assertFalse(any(event["type"] == "diagnostic_fit_started" for event in events))

    def test_unknown_or_duplicate_evidence_ids_and_hash_drift_fail_before_agent_code(self):
        document = self.document()
        path = self.root / "evidence.json"
        for rows in ([{"id": "sealed", "target": 1}], [{"id": "sample-000", "target": 0}] * 2,
                     [{"id": "sample-000", "target": True}]):
            path.write_text(json.dumps({"schemaVersion": 1, "labels": rows}))
            with self.assertRaises(ValueError):
                load_evidence(document["measurement"], {"sample-000"})
        document["measurement"]["evidenceManifestSha256"] = "0" * 64
        (self.root / "solutions/generic.py").write_text("raise AssertionError('agent imported before evidence preflight')")
        with self.assertRaisesRegex(ValueError, "changed since preflight"):
            self.execute(document)

    def test_partial_evidence_reports_coverage_and_never_invents_unlabelled_targets(self):
        document = self.document()
        path = self.root / "evidence.json"
        metadata = json.loads(path.read_text())
        metadata["labels"] = metadata["labels"][:12]
        path.write_text(json.dumps(metadata))
        result = self.execute(document)
        folds = result["diagnostics"]["folds"]
        self.assertTrue(all(fold["diagnostics"]["evidence"]["labelCoverage"] < 1 for fold in folds))
        self.assertEqual(sum(fold["diagnostics"]["evidence"]["labelledRows"] for fold in folds), 24)
        self.assertFalse(result["promotionEligible"])

    def test_evidence_objective_selects_advisory_candidates_without_fabricated_primary_metric(self):
        document = self.document("trusted")
        document["request"]["search"] = {"sampler": "grid", "space": {"mode": {"type": "categorical", "choices": ["anomaly"]}},
                                         "objective": {"kind": "proxy", "metric": "evidence_roc_auc", "direction": "maximize"}}
        result = self.execute(document)
        self.assertEqual(result["status"], "completed")
        self.assertIsNone(result["metrics"])
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["search"]["selectionMean"], 1)
        self.assertTrue(result["search"]["proxyEvidence"])


if __name__ == "__main__":
    unittest.main()
