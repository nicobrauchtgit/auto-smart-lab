"""Validation geometry, uncertainty assumptions and controlled auxiliary fits."""
import contextlib
import io
import json
import math
import shutil
import unittest

import numpy as np
from sklearn.metrics import roc_auc_score

import worker
import test_worker
import test_measurements
from smartlab_trial.uncertainty import operating_points, corrected_cv, binomial_interval
from smartlab_trial.metrics import _measure


CLASS = '''
import numpy as np
class DiagnosticPipeline(Pipeline):
    def fit(self, frame, y=None, **kwargs):
        assert not frame.attrs
        self.fit_ids_ = set(frame.id)
        return super().fit(frame, y, **kwargs)
    def predict(self, frame):
        assert not self.fit_ids_.intersection(frame.id), "Validation entered an auxiliary fit"
        return super().predict(frame)
    def diagnostic_slices(self, frame):
        assert not frame.attrs
        return {"all": np.ones(len(frame), dtype=bool), "offers": frame.text.str.contains("offer").to_numpy(),
                "empty": np.zeros(len(frame), dtype=bool)}
    def diagnostic_perturbations(self, frame, context):
        assert not frame.attrs
        neutral, erased, unknown = frame.copy(), frame.copy(), frame.copy()
        neutral["text"] = neutral.text.str.lower()
        erased["text"] = "unseen words"
        unknown["text"] = unknown.text.str.replace("limited offer prize", "project meeting agenda")
        return [{"name": "lowercase", "frame": neutral, "labelPreserving": True},
                {"name": "erase", "frame": erased, "labelPreserving": True},
                {"name": "unknown-labels", "frame": unknown, "labelPreserving": False}]
'''


class Uncertainty(unittest.TestCase):
    def test_empirical_low_fpr_does_not_interpolate_away_false_positive_ties(self):
        truth = [0, 0, 0, 0, 1, 1, 1, 1]
        values = [.5, .5, .2, .1, .5, .5, .9, .8]
        measured = operating_points(truth, values, [0, 0, 0, 0, 0, 0, 1, 1])
        for point in measured["points"]:
            self.assertEqual(point["falsePositives"], 0)
            self.assertEqual(point["recall"], .5)
            self.assertTrue(point["capBelowOneFalsePositive"])
            self.assertAlmostEqual(point["standardizedPartialAuc"], roc_auc_score(truth, values, max_fpr=point["maxFpr"]))
        self.assertEqual(measured["fprResolution"], .25)
        self.assertGreater(measured["pipelineDecision"]["fprBinomialInterval95"][1], 0)
        self.assertIsNone(binomial_interval(0, 0))

    def test_corrected_cv_uses_scope_and_widens_overlap_uncertainty(self):
        differences = [.1, .2, -.1, .05]
        folds = [{"trainRows": 80, "validationRows": 20, "execution": "inductive"}] * 4
        measured = corrected_cv(differences, folds)
        self.assertAlmostEqual(measured["standardError"], math.sqrt(.5 * np.var(differences, ddof=1)))
        self.assertGreater(measured["standardError"], np.std(differences, ddof=1) / 2)
        self.assertFalse(measured["changesPromotionRule"])
        self.assertFalse(corrected_cv(differences, [{**fold, "execution": "batch"} for fold in folds])["available"])
        self.assertFalse(corrected_cv([.1], folds[:1])["available"])

    def test_single_class_confusion_retains_false_predictions(self):
        measured = _measure([0, 0], [0, 1])
        self.assertEqual(measured["confusionMatrix"], [[1, 1], [0, 0]])


class ValidationWorker(unittest.TestCase):
    def setUp(self):
        self.fixture = test_worker.Worker()
        self.fixture.setUp()
        self.root = self.fixture.root
        self.addCleanup(shutil.rmtree, self.root)
        code = test_worker.PIPELINE.replace("def build_pipeline(context):", CLASS + "\ndef build_pipeline(context):").replace("return Pipeline(", "return DiagnosticPipeline(")
        (self.root / "solutions/pipeline.py").write_text(code)

    def execute(self, document):
        with contextlib.redirect_stdout(io.StringIO()):
            return worker.execute(document)

    def test_slices_and_perturbations_keep_primary_and_unknown_labels_are_not_scored(self):
        document = self.fixture.invocation()
        document["request"]["diagnostics"] = {"slices": {"method": "diagnostic_slices"}, "robustness": {"method": "diagnostic_perturbations"}}
        result = self.execute(document)
        self.assertEqual(result["metrics"]["balancedAccuracy"], 1)
        measured = result["diagnostics"]["folds"][0]["diagnostics"]
        offers = next(group for group in measured["slices"]["groups"] if group["name"] == "offers")
        self.assertFalse(offers["primaryAvailable"])
        self.assertFalse(measured["slices"]["groups"][-1]["available"])
        variants = {variant["name"]: variant for variant in measured["robustness"]["variants"]}
        self.assertEqual(variants["lowercase"]["agreement"]["predictionChangedFraction"], 0)
        self.assertEqual(variants["erase"]["metrics"]["balancedAccuracy"], .5)
        self.assertNotIn("metrics", variants["unknown-labels"])
        self.assertFalse(variants["unknown-labels"]["quality"]["available"])
        events = [json.loads(line) for line in (self.root / "run/events.jsonl").read_text().splitlines()]
        self.assertFalse(any(event["type"] == "diagnostic_fit_started" for event in events))

    def test_learning_curve_fits_only_training_subsets_and_reuses_full_size_fit_on_resume(self):
        document = self.fixture.invocation()
        document["request"]["diagnostics"] = {"learningCurve": {"fractions": [.5, 1]}}
        first = self.execute(document)
        points = first["diagnostics"]["folds"][0]["diagnostics"]["learningCurve"]["points"]
        self.assertTrue(points[-1]["reusedPrimaryFit"])
        self.assertEqual(points[0]["fitRows"], 8)
        self.assertTrue(all(point["validationRows"] == 8 for point in points))
        events_path = self.root / "run/events.jsonl"
        def fit_count():
            return sum(json.loads(line)["type"] == "diagnostic_fit_started" for line in events_path.read_text().splitlines())
        self.assertEqual(fit_count(), 6)
        second = self.execute(document)
        self.assertEqual(fit_count(), 6)
        self.assertEqual(first["diagnostics"], second["diagnostics"])


class BatchRobustness(unittest.TestCase):
    def test_batch_partition_robustness_uses_matched_diagnostic_populations_and_observed_fits(self):
        fixture = test_measurements.MeasurementWorker()
        fixture.setUp()
        root = fixture.fixture.root
        self.addCleanup(shutil.rmtree, root)
        hook = '''
    def perturb(self, frame, context):
        assert not frame.attrs
        return [{"name": "identity", "frame": frame.copy(), "labelPreserving": True}]
'''
        code = test_measurements.PIPELINE.replace("    def fit(self, frame, y=None):", hook + "\n    def fit(self, frame, y=None):")
        (root / "solutions/generic.py").write_text(code)
        document = fixture.document()
        document["request"]["diagnostics"] = {"robustness": {"method": "perturb", "maxRows": 10}}
        with contextlib.redirect_stdout(io.StringIO()):
            result = worker.execute(document)
        measured = result["diagnostics"]["folds"][0]["diagnostics"]["robustness"]
        self.assertTrue(measured["baselineRefittedOnDiagnosticBatch"])
        self.assertEqual(measured["measuredRows"], 10)
        self.assertEqual(measured["variants"][0]["agreement"]["partitionAdjustedRandIndex"], 1)
        events = [json.loads(line) for line in (root / "generic/events.jsonl").read_text().splitlines()]
        self.assertEqual(sum(event["type"] == "diagnostic_fit_started" for event in events), 12)
        self.assertTrue(all(not event["targetsPassed"] for event in events if event["type"] == "diagnostic_fit_started"))


if __name__ == "__main__":
    unittest.main()
