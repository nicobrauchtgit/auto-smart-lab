"""Configured allowance against work actually completed."""
import sys
import unittest
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sklearn.exceptions import ConvergenceWarning
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression, SGDClassifier
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline

from solve.convergence import capture_convergence_warnings, inspect_fitted, summarise

TEXT = [f"free money offer {index}" if index % 2 else f"meeting notes {index}" for index in range(60)]
LABELS = [index % 2 for index in range(60)]


def _record(records, name):
    return next(entry for entry in records if entry["estimator"] == name)


class Inspection(unittest.TestCase):
    def test_reads_completed_iterations_from_inside_a_pipeline(self):
        model = Pipeline([("tfidf", TfidfVectorizer()),
                          ("clf", LogisticRegression(max_iter=500, random_state=0))]).fit(TEXT, LABELS)
        record = _record(inspect_fitted(model), "LogisticRegression")
        self.assertEqual(record["path"], "clf")
        # lbfgs iterations are solver steps, not passes over the data.
        self.assertEqual(record["step_unit"], "solver steps")
        self.assertEqual(record["configured_iterations"], 500)
        self.assertLess(record["completed_iterations"], 500)
        self.assertFalse(record["reached_limit"])

    def test_a_fit_that_used_its_whole_allowance_says_so(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            model = LogisticRegression(max_iter=1, random_state=0).fit(
                TfidfVectorizer().fit_transform(TEXT), LABELS)
        record = _record(inspect_fitted(model), "LogisticRegression")
        self.assertEqual(record["completed_iterations"], 1)
        self.assertTrue(record["reached_limit"])

    def test_records_the_controls_that_default_to_off(self):
        model = SGDClassifier(max_iter=20, early_stopping=True, n_iter_no_change=3,
                              tol=1e-3, random_state=0).fit(np.eye(60), LABELS)
        record = _record(inspect_fitted(model), "SGDClassifier")
        self.assertEqual(record["step_unit"], "epochs")
        self.assertTrue(record["controls"]["early_stopping"])
        self.assertEqual(record["controls"]["n_iter_no_change"], 3)
        self.assertIn("warm_start", record["controls"])

    def test_multi_class_iteration_arrays_collapse_to_the_largest(self):
        model = LogisticRegression(max_iter=400, random_state=0).fit(
            TfidfVectorizer().fit_transform(TEXT), LABELS)
        record = _record(inspect_fitted(model), "LogisticRegression")
        self.assertIsInstance(record["completed_iterations"], int)

    def test_an_estimator_with_no_convergence_story_is_left_out(self):
        model = Pipeline([("tfidf", TfidfVectorizer()), ("clf", MultinomialNB())]).fit(TEXT, LABELS)
        names = [entry["estimator"] for entry in inspect_fitted(model)]
        self.assertNotIn("TfidfVectorizer", names)
        self.assertNotIn("MultinomialNB", names)

    def test_an_unfittable_object_is_measured_as_nothing_rather_than_raising(self):
        self.assertEqual(inspect_fitted(object()), [])


class Warnings(unittest.TestCase):
    def test_a_convergence_warning_is_collected(self):
        with capture_convergence_warnings() as raised:
            LogisticRegression(max_iter=1, random_state=0).fit(
                TfidfVectorizer().fit_transform(TEXT), LABELS)
        self.assertEqual(len(raised), 1)
        self.assertIn("converge", raised[0].lower())

    def test_a_converged_fit_raises_nothing(self):
        with capture_convergence_warnings() as raised:
            LogisticRegression(max_iter=500, random_state=0).fit(
                TfidfVectorizer().fit_transform(TEXT), LABELS)
        self.assertEqual(raised, [])

    def test_the_summary_carries_the_scope_it_was_measured_at(self):
        with capture_convergence_warnings() as raised:
            model = Pipeline([("tfidf", TfidfVectorizer()),
                              ("clf", LogisticRegression(max_iter=500, random_state=0))]).fit(TEXT, LABELS)
        summary = summarise(model, "canary_sample", len(TEXT), raised)
        self.assertEqual(summary["scope"], "canary_sample")
        self.assertEqual(summary["rows"], len(TEXT))
        self.assertEqual(summary["convergence_warnings"], [])
        self.assertTrue(summary["estimators"])


if __name__ == "__main__":
    unittest.main()
