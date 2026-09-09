"""`Results` refuses ids the stage would reject, while the session can still act.

The stage checks the same things when it grades a run, but by then the agent is
gone. These tests pin the checks to the moment the ids are supplied.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path


from smartlab_eval import Results

DEV = [f"data/train/doc{index:03d}.{index % 2}" for index in range(20)]
SEALED = [f"data/train/held{index:03d}.{index % 2}" for index in range(4)]


class ResultsIds(unittest.TestCase):
    def setUp(self):
        self.workspace = Path(tempfile.mkdtemp())
        data = self.workspace / "data"
        data.mkdir()
        (data / "task-train-dev.labels").write_text(
            "\n".join(f"{row_id};{index % 2}" for index, row_id in enumerate(DEV)) + "\n")
        (data / "sealed_ids.txt").write_text("\n".join(SEALED) + "\n")

    def results(self):
        return Results(workspace=self.workspace)

    def labels_for(self, ids):
        return [index % 2 for index, _ in enumerate(ids)]

    def test_the_file_name_mistake_is_refused_on_the_first_fold(self):
        names = [row_id.rsplit("/", 1)[-1] for row_id in DEV]
        with self.assertRaises(ValueError) as caught:
            self.results().add_fold(0, 0, names, self.labels_for(names), self.labels_for(names))
        message = str(caught.exception)
        self.assertIn("not development rows", message)
        self.assertIn("match a known row by file name", message)
        self.assertIn("full path inside the archive", message)

    def test_a_sealed_id_in_cross_validation_is_named_as_sealed(self):
        ids = DEV[:4] + SEALED[:1]
        with self.assertRaises(ValueError) as caught:
            self.results().add_fold(0, 0, ids, self.labels_for(ids), self.labels_for(ids))
        self.assertIn("are sealed", str(caught.exception))
        self.assertIn("set_confirmation", str(caught.exception))

    def test_correct_ids_are_accepted(self):
        results = self.results()
        results.add_fold(0, 0, DEV[:10], self.labels_for(DEV[:10]), self.labels_for(DEV[:10]))
        results.add_fold(0, 1, DEV[10:], self.labels_for(DEV[10:]), self.labels_for(DEV[10:]))
        target = results.write(
            cv={"scheme": "stratified_kfold", "folds": 2, "repeats": 1, "seed": 1},
            entrypoint={"module": "solutions/tasks/task.py", "factory": "build_pipeline"},
            approach="test")
        self.assertTrue(target.is_file())

    def test_an_incomplete_repeat_is_refused_before_anything_is_written(self):
        results = self.results()
        results.add_fold(0, 0, DEV[:10], self.labels_for(DEV[:10]), self.labels_for(DEV[:10]))
        with self.assertRaises(ValueError) as caught:
            results.write(
                cv={"scheme": "stratified_kfold", "folds": 2, "repeats": 1, "seed": 1},
                entrypoint={"module": "solutions/tasks/task.py", "factory": "build_pipeline"},
                approach="test")
        self.assertIn("covers 10 of 20 development rows", str(caught.exception))
        self.assertFalse((self.workspace / "oof_predictions.csv").exists())

    def test_validation_is_skipped_where_the_workspace_holds_no_id_lists(self):
        bare = Path(tempfile.mkdtemp())
        results = Results(workspace=bare)
        results.add_fold(0, 0, ["whatever.0", "other.1"], [0, 1], [0, 1])
        self.assertEqual(len(results._oof), 2)

    def test_the_workspace_comes_from_the_environment_when_unset(self):
        os.environ["SOLVE_WORKSPACE"] = str(self.workspace)
        try:
            with self.assertRaises(ValueError) as caught:
                Results().add_fold(0, 0, ["doc000.0"], [0], [0])
            self.assertIn("not development rows", str(caught.exception))
        finally:
            del os.environ["SOLVE_WORKSPACE"]


if __name__ == "__main__":
    unittest.main()
