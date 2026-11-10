"""Prediction-based metric integrity and real harness execution for new task kinds."""
import contextlib
import hashlib
import io
import json
import random
import unittest
from itertools import combinations
from pathlib import Path

import numpy as np

import worker
import test_worker
from smartlab_trial import diagnostics
from smartlab_trial.champion import pair_changes
from smartlab_trial.search import RuntimeGuard


PIPELINE = '''
import numpy as np
from sklearn.base import BaseEstimator

class Fixture(BaseEstimator):
    def __init__(self, random_state=None, mode="clusters"):
        self.random_state = random_state
        self.mode = mode
    def fit(self, frame, y=None):
        assert y is None, "Family targets must not enter an unsupervised fit"
        self.fitted_ids_ = set(frame.id)
        self.negative_outlier_factor_ = -np.array([float(x[0]) for x in frame.input])
        return self
    def predict(self, frame):
        if self.mode == "anomaly":
            assert not self.fitted_ids_.intersection(frame.id)
            return np.array([-1 if x[0] > 1 else 1 for x in frame.input])
        return np.array([int(x[0]) + (self.random_state % 2) * 10 for x in frame.input])
    def fit_predict(self, frame):
        self.fit(frame)
        return np.array([int(x[0]) + (self.random_state % 2) * 10 for x in frame.input])
    def score_samples(self, frame):
        assert not self.fitted_ids_.intersection(frame.id)
        return np.array([-float(x[0]) for x in frame.input])

def build_pipeline(context):
    return Fixture(mode=context["parameters"].get("mode", "clusters"))
'''


class Signals(unittest.TestCase):
    def test_split_merge_diagnostics_and_noise_coverage(self):
        truth = ["a", "a", "b", "b"]
        merged = diagnostics.clustering(truth, [0, 0, 0, 0])
        split = diagnostics.clustering(truth, [0, 1, 2, 3])
        self.assertEqual(merged["external"]["completeness"], 1)
        self.assertLess(merged["external"]["homogeneity"], 1)
        self.assertAlmostEqual(split["external"]["homogeneity"], 1)
        self.assertLess(split["external"]["completeness"], 1)
        noisy = diagnostics.clustering(truth, [-1, -1, 4, 4])
        self.assertEqual(noisy["structure"]["assignedFraction"], .5)
        self.assertEqual(noisy["external"]["pairConfusion"]["trueSame"], 2)
        self.assertEqual(noisy["external"]["adjustedRandIndex"], 1)

    def test_pair_changes_match_brute_force_with_label_permutations(self):
        rng = random.Random(7)
        for _ in range(100):
            truth, old, new = [[rng.randrange(3) for _ in range(12)] for _ in range(3)]
            expected = dict.fromkeys(["correctedSplitPairs", "correctedMergePairs", "introducedSplitPairs", "introducedMergePairs"], 0)
            for i, j in combinations(range(12), 2):
                same, before, after = truth[i] == truth[j], old[i] == old[j], new[i] == new[j]
                if before != same and after == same:
                    expected["correctedSplitPairs" if same else "correctedMergePairs"] += 1
                if before == same and after != same:
                    expected["introducedSplitPairs" if same else "introducedMergePairs"] += 1
            measured = pair_changes(truth, old, new)
            for key, value in expected.items():
                self.assertEqual(measured[key], value)

    def test_probability_calibration_is_not_claimed_for_margins(self):
        truth = [0, 0, 1, 1]
        probabilities = diagnostics.classification(truth, truth, [.1, .2, .8, .9], {"kind": "probability"})
        margins = diagnostics.classification(truth, truth, [-2, -1, 1, 2], {"kind": "margin"})
        self.assertTrue(probabilities["calibration"]["available"])
        self.assertEqual(sum(b["rows"] for b in probabilities["calibration"]["bins"]), 4)
        self.assertFalse(margins["calibration"]["available"])
        self.assertTrue(margins["thresholdSweep"]["advisory"])
        self.assertTrue(margins["thresholdSweep"]["selectedOnEvaluationRows"])
        with self.assertRaisesRegex(ValueError, "Probabilities"):
            diagnostics.classification(truth, truth, [-1, .2, .8, 2], {"kind": "probability"})

    def test_constant_anomaly_scores_and_unavailable_stability(self):
        measured = diagnostics.anomaly([1, 1, 1], None, direction="lower_is_anomalous", anomaly_label=-1)
        self.assertTrue(measured["constantScores"])
        self.assertIsNone(measured["predictedAnomalyFraction"])
        self.assertTrue(measured["proxyEvidence"])
        self.assertFalse(diagnostics.stability([], "clustering")["available"])
        with self.assertRaisesRegex(ValueError, "finite"):
            diagnostics.anomaly([1, np.nan], None, direction="lower_is_anomalous", anomaly_label=-1)

    def test_stability_uses_common_ids_and_label_invariant_partitions(self):
        rows = []
        for repeat, ids, labels in [(0, ["a", "b", "c", "d"], [0, 0, 1, 1]),
                                    (1, ["c", "b", "a", "x"], [9, 7, 7, 9])]:
            rows.extend({"id": key, "repeat": repeat, "fold": 0, "prediction": label, "score": 0}
                        for key, label in zip(ids, labels))
        result = diagnostics.stability(rows, "clustering")
        self.assertEqual(result["comparisons"][0]["commonRows"], 3)
        self.assertEqual(result["summary"]["mean"], 1)
        self.assertTrue(result["proxyEvidence"])

    def test_anomaly_top_rank_overlap_obeys_score_direction_and_ties(self):
        rows = [{"id": str(i), "repeat": repeat, "fold": 0, "score": float(i if repeat == 0 else -i), "prediction": -1}
                for repeat in (0, 1) for i in range(20)]
        result = diagnostics.stability(rows, "anomaly_detection", "lower_is_anomalous")
        self.assertAlmostEqual(result["summary"]["mean"], -1)
        self.assertEqual(result["comparisons"][0]["topAnomalyOverlap"][0]["jaccard"], 0)
        for row in rows:
            row["score"] = 1
        tied = diagnostics.stability(rows, "anomaly_detection")
        self.assertFalse(tied["summary"]["available"])
        self.assertTrue(tied["comparisons"][0]["topAnomalyOverlap"][0]["boundaryTies"])


class MeasurementWorker(unittest.TestCase):
    def setUp(self):
        self.fixture = test_worker.Worker()
        self.fixture.setUp()
        self.addCleanup(__import__("shutil").rmtree, self.fixture.root)
        (self.fixture.root / "solutions/generic.py").write_text(PIPELINE)

    def document(self, kind="clustering", *, targets=True, execution="batch", scheme="kfold"):
        document = self.fixture.invocation("generic", cv={"kind": "builtin", "scheme": scheme, "folds": 3, "repeats": 2})
        samples = [{"id": f"sample-{i:03d}", "input": [i % 6, i], **({"target": f"family-{i % 6}"} if targets else {})}
                   for i in range(48)]
        path = self.fixture.root / "samples.json"
        path.write_text(json.dumps({"schemaVersion": 1, "samples": samples}))
        document["request"]["pipeline"]["module"] = "solutions/generic.py"
        document["request"]["pipeline"]["parameters"] = {"mode": "anomaly" if kind == "anomaly_detection" else "clusters"}
        document["measurement"] = {"kind": kind, "sampleManifestPath": str(path), "execution": execution,
                                   "hasTargets": targets,
                                   "sampleManifestSha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        if kind == "anomaly_detection":
            document["measurement"].update(scoreMethod="score_samples", scoreDirection="lower_is_anomalous", anomalyLabel=-1)
        # Generic execution must not depend on text archives or binary labels.
        del document["inputs"]["zipPath"], document["inputs"]["labelsPath"]
        return document

    def execute(self, document):
        with contextlib.redirect_stdout(io.StringIO()):
            return worker.execute(document)

    def test_batch_clustering_owns_fits_and_never_pools_cluster_numbers(self):
        result = self.execute(self.document())
        self.assertTrue(result["promotionEligible"])
        self.assertEqual(result["metrics"]["adjustedRandIndex"], 1)
        self.assertTrue(result["diagnostics"]["stability"]["available"])
        self.assertEqual(result["diagnostics"]["stability"]["summary"]["mean"], 1)
        folds = [json.loads(line) for line in (self.fixture.root / "generic/fold-results.jsonl").read_text().splitlines()]
        self.assertTrue(all(fold["fitRows"] == fold["validationRows"] for fold in folds))
        self.assertTrue(all(fold["execution"] == "batch" for fold in folds))

    def test_group_holdout_keeps_whole_unseen_families_together(self):
        document = self.document(execution="inductive", scheme="group_kfold")
        self.execute(document)
        frame, y, _ = worker._prepare_data(worker.parse_invocation(document))
        manifest = json.loads((self.fixture.root / "generic/fold-manifest.json").read_text())
        for fold in manifest["folds"]:
            self.assertFalse({y[i] for i in fold["trainIndices"]} & {y[i] for i in fold["validationIndices"]})

    def test_search_cost_projection_counts_actually_fitted_rows(self):
        for execution, expected in (("batch", 10), ("inductive", 20)):
            document = self.document(execution=execution)
            document["runtime"] = {"priorFitSeconds": 5, "priorTrainRows": 8}
            invocation = worker.parse_invocation(document)
            frame, y, _ = worker._prepare_data(invocation)
            folds = worker._materialize_folds(invocation.cv, invocation.scope, frame, y,
                                             invocation.code_root, invocation.trial_seed)
            guard = RuntimeGuard(invocation, 2, folds, 0)
            self.assertEqual(guard.prior, expected)

    def test_label_free_detection_reports_proxies_and_cannot_promote(self):
        result = self.execute(self.document("anomaly_detection", targets=False, execution="inductive"))
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["promotionIneligibleReason"], "unlabelled_proxy_evidence")
        self.assertIsNone(result["metrics"])
        self.assertTrue(result["diagnostics"]["proxyEvidence"])
        self.assertAlmostEqual(result["diagnostics"]["stability"]["summary"]["mean"], 1)
        self.assertIn("thresholdSensitivity", result["diagnostics"]["folds"][0]["diagnostics"])

    def test_batch_anomaly_scores_can_come_from_fitted_row_attributes(self):
        document = self.document("anomaly_detection", targets=False)
        document["measurement"]["scoreMethod"] = "negative_outlier_factor_"
        result = self.execute(document)
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["diagnostics"]["folds"][0]["diagnostics"]["scoreProvenance"]["method"], "negative_outlier_factor_")

    def test_missing_or_changed_metadata_prevents_agent_module_import(self):
        document = self.document()
        (self.fixture.root / "solutions/generic.py").write_text("raise AssertionError('agent code imported')")
        path = Path(document["measurement"]["sampleManifestPath"])
        path.write_text("{}")
        with self.assertRaisesRegex(worker.InvocationError, "changed since preflight"):
            self.execute(document)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.execute(document)

    def test_label_free_clustering_still_has_structure_but_no_promotion(self):
        result = self.execute(self.document(targets=False))
        self.assertFalse(result["promotionEligible"])
        self.assertFalse(result["diagnostics"]["folds"][0]["diagnostics"]["external"]["available"])
        self.assertTrue(result["diagnostics"]["proxyEvidence"])
        self.assertIsNone(result["diagnostics"]["primaryMetric"])

    def test_diagnostics_survive_completed_fold_resume_without_refitting(self):
        document = self.document()
        first = self.execute(document)
        (self.fixture.root / "solutions/generic.py").write_text("def build_pipeline(context): raise AssertionError('unexpected fit')")
        # Agent factory is loaded, but no fitted checkpoint is replayed as a new fit.
        second = self.execute(document)
        self.assertEqual(first["metrics"], second["metrics"])
        self.assertEqual(first["diagnostics"], second["diagnostics"])

    def test_supervised_signals_are_in_harness_result(self):
        result = self.execute(self.fixture.invocation())
        signals = result["diagnostics"]
        self.assertEqual(signals["ranking"]["rocAuc"]["mean"], 1)
        self.assertFalse(signals["foldSpreadIsConfidenceInterval"])
        self.assertTrue(signals["folds"][0]["diagnostics"]["calibration"]["available"])
        self.assertIn("perClass", result["metrics"])


if __name__ == "__main__":
    unittest.main()
