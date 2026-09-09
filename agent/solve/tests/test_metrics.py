"""Measurement tests. Expected values are computed by hand, not by another library."""
import math
import sys
import unittest
from pathlib import Path


from smartlab_eval import metrics as m


class BalancedAccuracy(unittest.TestCase):
    def test_matches_a_hand_computed_value(self):
        # class 0: 4 rows, 3 correct -> 0.75; class 1: 2 rows, 1 correct -> 0.5
        truth = [0, 0, 0, 0, 1, 1]
        predicted = [0, 0, 0, 1, 1, 0]
        self.assertAlmostEqual(m.balanced_accuracy(truth, predicted), (0.75 + 0.5) / 2)

    def test_ignores_class_imbalance(self):
        truth = [0] * 99 + [1]
        self.assertAlmostEqual(m.balanced_accuracy(truth, [0] * 100), 0.5)

    def test_confusion_counts(self):
        counts = m.confusion([0, 0, 1, 1], [0, 1, 0, 1])
        self.assertEqual(counts, {"tn": 1, "fp": 1, "fn": 1, "tp": 1})

    def test_rejects_a_missing_class(self):
        with self.assertRaises(ValueError):
            m.balanced_accuracy([0, 0], [0, 0])

    def test_rejects_non_binary_labels(self):
        with self.assertRaises(ValueError):
            m.balanced_accuracy([0, 2], [0, 1])

    def test_rejects_mismatched_lengths(self):
        with self.assertRaises(ValueError):
            m.balanced_accuracy([0, 1], [0])


class Curves(unittest.TestCase):
    def test_auc_of_a_perfect_ranking_is_one(self):
        self.assertAlmostEqual(m.roc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]).auc, 1.0)

    def test_auc_of_a_reversed_ranking_is_zero(self):
        self.assertAlmostEqual(m.roc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]).auc, 0.0)

    def test_curve_survives_json(self):
        import json
        curve = m.roc([0, 1] * 20, [i / 40 for i in range(40)])
        self.assertTrue(all(math.isfinite(value) for value in json.loads(json.dumps(curve.as_dict()))["thresholds"]))

    def test_threshold_sweep_finds_the_separating_point(self):
        sweep = m.threshold_sweep([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9])
        self.assertAlmostEqual(sweep["best_balanced_accuracy"], 1.0)
        self.assertGreater(sweep["best_threshold"], 0.2)
        self.assertLessEqual(sweep["best_threshold"], 0.8)

    def test_threshold_sweep_reports_the_default_operating_point(self):
        # Every score sits below 0.5, so the default threshold calls everything 0.
        sweep = m.threshold_sweep([0, 0, 1, 1], [0.01, 0.02, 0.03, 0.04])
        self.assertAlmostEqual(sweep["at_default_threshold"], 0.5)


class Comparison(unittest.TestCase):
    def setUp(self):
        self.truth = [0, 0, 1, 1]
        self.baseline = [0, 1, 0, 1]      # one error per class
        self.candidate = [0, 0, 0, 1]     # fixes the class-0 error, adds nothing

    def test_counts_corrected_and_introduced_separately(self):
        result = m.compare(self.truth, self.baseline, self.candidate)
        self.assertEqual(result["corrected"], 1)
        self.assertEqual(result["introduced"], 0)
        self.assertAlmostEqual(result["delta"], 0.25)

    def test_a_pure_reshuffle_shows_as_churn(self):
        # Every example the baseline got right is now wrong and vice versa, so the
        # aggregate is unchanged while four predictions moved.
        result = m.compare(self.truth, [0, 1, 0, 1], [1, 0, 1, 0])
        self.assertEqual(result["corrected"], 2)
        self.assertEqual(result["introduced"], 2)
        self.assertAlmostEqual(result["delta"], 0.0)

    def test_bootstrap_is_reproducible_at_a_fixed_seed(self):
        truth = [0, 1] * 60
        baseline = [0, 0] * 60
        candidate = [0, 1] * 60
        first = m.paired_bootstrap(truth, baseline, candidate, resamples=200, seed=5)
        again = m.paired_bootstrap(truth, baseline, candidate, resamples=200, seed=5)
        self.assertEqual(first, again)

    def test_a_real_gain_clears_zero_and_no_difference_does_not(self):
        truth = [0, 1] * 60
        strong = m.paired_bootstrap(truth, [0, 0] * 60, [0, 1] * 60, resamples=300, seed=5)
        none = m.paired_bootstrap(truth, [0, 1] * 60, [0, 1] * 60, resamples=300, seed=5)
        self.assertTrue(strong["clears_zero"])
        self.assertFalse(none["clears_zero"])
        self.assertAlmostEqual(none["delta"], 0.0)


class FoldScoring(unittest.TestCase):
    def test_score_fold_reports_both_recalls_and_omits_auc_without_scores(self):
        scored = m.score_fold(0, 2, [0, 0, 1, 1], [0, 1, 1, 1]).as_dict()
        self.assertEqual(scored["fold"], 2)
        self.assertEqual(scored["n"], 4)
        self.assertAlmostEqual(scored["recall_0"], 0.5)
        self.assertAlmostEqual(scored["recall_1"], 1.0)
        self.assertNotIn("roc_auc", scored)

    def test_score_fold_includes_auc_when_scores_are_supplied(self):
        scored = m.score_fold(0, 0, [0, 0, 1, 1], [0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]).as_dict()
        self.assertAlmostEqual(scored["roc_auc"], 1.0)


if __name__ == "__main__":
    unittest.main()
