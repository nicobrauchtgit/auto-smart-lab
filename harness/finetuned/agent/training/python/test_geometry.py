"""Geometry correctness, explicit proxy selection, and fit ownership."""
import contextlib
import io
import json
import shutil
import unittest

import numpy as np
from sklearn.metrics import silhouette_score

import worker
from smartlab_trial.geometry import density_validity, measure, prediction_strength
from smartlab_trial.options import validate_options
import test_measurements


class Geometry(unittest.TestCase):
    def test_noise_coverage_and_sampled_silhouette_match_reference(self):
        class Features:
            def features(self, frame):
                return frame.to_numpy()
        import pandas as pd
        x = np.array([[0., 0.], [0., .1], [.1, 0.], [10., 10.], [10., 10.1], [10.1, 10.], [100., 100.]])
        labels = [10, 10, 10, 99, 99, 99, -1]
        result = measure(Features(), pd.DataFrame(x), labels, {"source": "method", "method": "features", "dbcv": True}, 7)
        self.assertAlmostEqual(result["silhouette"]["value"], silhouette_score(x[:-1], labels[:-1]))
        self.assertEqual(result["assignedRows"], 6)
        self.assertEqual(result["measuredRows"], 7)
        self.assertGreater(result["dbcv"]["value"], .8)
        clean = density_validity(x[:-1], np.array(labels[:-1]))
        self.assertAlmostEqual(result["dbcv"]["value"], clean["value"] * 6 / 7)

    def test_degenerate_geometry_and_small_density_clusters_are_explicit(self):
        self.assertFalse(density_validity(np.zeros((4, 2)), np.array([0, 0, 1, 1]))["available"])
        self.assertFalse(density_validity(np.zeros((6, 2)), np.array([0, 0, 0, 1, 1, 1]))["available"])
        self.assertEqual(prediction_strength([0, 0, 1, 1], [5, 5, 7, 7])["value"], 1)
        self.assertEqual(prediction_strength([0, 0, 1, 1], [5, 6, 7, 7])["value"], 0)
        self.assertEqual(prediction_strength([0, 0], [-1, -1])["value"], 0)
        self.assertFalse(prediction_strength([0, 1], [5, 7])["available"])

    def test_diagnostic_request_bounds_and_proxy_declaration(self):
        for options in ({"representation": {"source": "raw_input"}},
                        {"representation": {"source": "method", "method": "features", "maxRows": 100000}},
                        {"predictionStrength": "yes"}):
            with self.assertRaises(ValueError):
                validate_options({"diagnostics": options})
        with self.assertRaisesRegex(ValueError, "requires diagnostics.representation"):
            validate_options({"search": {"objective": {"kind": "proxy", "metric": "silhouette", "direction": "maximize"}}})


class GeometryWorker(unittest.TestCase):
    def setUp(self):
        self.fixture = test_measurements.MeasurementWorker()
        self.fixture.setUp()
        self.addCleanup(shutil.rmtree, self.fixture.fixture.root)
        # The original fixture owns unsupervised fit assertions and harness randomness.
        code = test_measurements.PIPELINE.replace("    def predict(self, frame):", "    def features(self, frame):\n        return np.array([[float(x[0])] for x in frame.input])\n    def predict(self, frame):")
        (self.fixture.fixture.root / "solutions/generic.py").write_text(code)

    def execute(self, document):
        with contextlib.redirect_stdout(io.StringIO()):
            return worker.execute(document)

    def test_label_free_geometry_search_is_advisory_and_confirmation_keeps_options(self):
        document = self.fixture.document(targets=False)
        document["request"]["diagnostics"] = {"representation": {"source": "method", "method": "features"}}
        document["request"]["search"] = {"space": {"factory.mode": {"type": "categorical", "choices": ["clusters"]}},
                                         "sampler": "grid", "objective": {"kind": "proxy", "metric": "silhouette", "direction": "maximize"}}
        result = self.execute(document)
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["promotionEligible"])
        self.assertIsNone(result["metrics"])
        report = json.loads((self.fixture.fixture.root / "generic/search-report.json").read_text())
        self.assertTrue(report["proxyEvidence"])
        self.assertEqual(report["nextStep"]["confirmationRequest"]["diagnostics"], document["request"]["diagnostics"])

    def test_prediction_strength_additional_fit_is_observed_and_has_no_family_targets(self):
        document = self.fixture.document(execution="inductive")
        document["request"]["diagnostics"] = {"predictionStrength": True}
        result = self.execute(document)
        self.assertEqual(result["diagnostics"]["folds"][0]["diagnostics"]["predictionStrength"]["value"], 1)
        events = [json.loads(line) for line in (self.fixture.fixture.root / "generic/events.jsonl").read_text().splitlines()]
        fits = [event for event in events if event["type"] == "diagnostic_fit_started"]
        self.assertEqual(len(fits), 6)
        self.assertTrue(all(event["targetsPassed"] is False for event in fits))


if __name__ == "__main__":
    unittest.main()
