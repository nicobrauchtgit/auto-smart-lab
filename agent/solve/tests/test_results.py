"""The results contract writer catches the mistakes the stage would otherwise reject."""
import json
import sys
import tempfile
import unittest
from pathlib import Path


from smartlab_eval import Results, read_sealed_ids

CV = {"scheme": "stratified_kfold", "folds": 2, "repeats": 1, "seed": 13}
ENTRY = {"module": "solutions/tasks/demo.py", "factory": "build_pipeline"}


class ResultsContract(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.results = Results(workspace=self.dir)

    def _two_folds(self, results=None):
        target = results or self.results
        target.add_fold(0, 0, ["a", "b"], [0, 1], [0, 1])
        target.add_fold(0, 1, ["c", "d"], [0, 1], [0, 0])
        target.set_confirmation(["s1", "s2"], [0, 1])
        return target

    def test_writes_the_expected_files_and_schema(self):
        self._two_folds().write(cv=CV, entrypoint=ENTRY, approach="demo", variants_compared=3)
        document = json.loads((self.dir / "metrics.json").read_text())
        self.assertEqual(document["schema_version"], 1)
        self.assertEqual(document["cv"], CV)
        self.assertEqual(document["entrypoint"], ENTRY)
        self.assertEqual(document["variants_compared"], 3)
        self.assertFalse(document["done"])
        # fold 0 is perfect, fold 1 misses the positive: (1.0 + 0.5) / 2
        self.assertAlmostEqual(document["mean_bacc"], 0.75)
        self.assertTrue((self.dir / "oof_predictions.csv").is_file())
        # The held-out split is scored by the harness from the declared factory,
        # so the agent writes no predictions for it.
        self.assertFalse((self.dir / "confirmation_predictions.csv").exists())

    def test_prediction_file_header_and_rows(self):
        self._two_folds().write(cv=CV, entrypoint=ENTRY, approach="demo")
        lines = (self.dir / "oof_predictions.csv").read_text().splitlines()
        self.assertEqual(lines[0], "id;repeat;fold;prediction")
        self.assertEqual(lines[1], "a;0;0;0")
        self.assertEqual(len(lines), 5)

    def test_score_column_appears_only_when_scores_are_supplied(self):
        self.results.add_fold(0, 0, ["a", "b"], [0, 1], [0, 1], [0.1, 0.9])
        self.results.add_fold(0, 1, ["c", "d"], [0, 1], [0, 1], [0.2, 0.8])
        self.results.set_confirmation(["s1", "s2"], [0, 1], [0.3, 0.7])
        self.results.write(cv=CV, entrypoint=ENTRY, approach="demo")
        self.assertTrue((self.dir / "oof_predictions.csv").read_text().startswith("id;repeat;fold;prediction;score"))
        self.assertIn("roc", json.loads((self.dir / "curves.json").read_text()))

    def test_rejects_a_repeated_id_within_one_repeat(self):
        self.results.add_fold(0, 0, ["a", "b"], [0, 1], [0, 1])
        with self.assertRaisesRegex(ValueError, "already has a prediction"):
            self.results.add_fold(0, 1, ["a", "z"], [0, 1], [0, 1])

    def test_names_the_fold_when_it_holds_only_one_class(self):
        with self.assertRaisesRegex(ValueError, "repeat 0 fold 3"):
            self.results.add_fold(0, 3, ["a", "b"], [0, 0], [0, 0])

    def test_allows_the_same_id_in_a_second_repeat(self):
        self.results.add_fold(0, 0, ["a", "b"], [0, 1], [0, 1])
        self.results.add_fold(1, 0, ["a", "b"], [0, 1], [0, 1])
        self.assertEqual(len(self.results._oof), 4)

    def test_rejects_a_contradictory_label_for_one_id(self):
        self.results.add_fold(0, 0, ["a", "b"], [0, 1], [0, 1])
        with self.assertRaisesRegex(ValueError, "was given label"):
            self.results.add_fold(1, 0, ["a", "b"], [1, 0], [1, 0])

    def test_rejects_mismatched_input_lengths(self):
        with self.assertRaises(ValueError):
            self.results.add_fold(0, 0, ["a", "b"], [0], [0])

    def test_refuses_to_write_without_folds(self):
        with self.assertRaisesRegex(ValueError, "no folds"):
            self.results.write(cv=CV, entrypoint=ENTRY, approach="demo")

    def test_requires_a_complete_cv_description_and_entrypoint(self):
        self._two_folds()
        with self.assertRaisesRegex(ValueError, "cv is missing"):
            self.results.write(cv={"scheme": "x", "folds": 2}, entrypoint=ENTRY, approach="demo")
        with self.assertRaisesRegex(ValueError, "entrypoint is missing"):
            self.results.write(cv=CV, entrypoint={"module": "m"}, approach="demo")

    def test_needs_a_workspace(self):
        import os
        previous = os.environ.pop("SOLVE_WORKSPACE", None)
        try:
            with self.assertRaisesRegex(ValueError, "SOLVE_WORKSPACE"):
                Results()
        finally:
            if previous is not None:
                os.environ["SOLVE_WORKSPACE"] = previous

    def test_reads_the_sealed_id_list(self):
        (self.dir / "data").mkdir()
        (self.dir / "data" / "sealed_ids.txt").write_text("one\ntwo\n\n")
        self.assertEqual(read_sealed_ids(self.dir), ["one", "two"])


if __name__ == "__main__":
    unittest.main()
