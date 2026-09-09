"""What an iteration reports when the results files do not comply.

A compliance failure means the score cannot be compared across iterations. It
does not mean nothing can be said about the pipeline, and these tests pin the
difference: the iteration is unmeasurable, and the canary still ran.
"""
import argparse
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from solve.iteration import evaluate

PIPELINE = '''
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, FunctionTransformer

def build_pipeline():
    return Pipeline([
        ("text", FunctionTransformer(lambda frame: frame["text"], validate=False)),
        ("tfidf", TfidfVectorizer()),
        ("model", LogisticRegression(max_iter=200, random_state=0)),
    ])
'''

ROWS = 60
SEALED = 10


class Iteration(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "solutions" / "tasks").mkdir(parents=True)
        (self.root / "solutions" / "tasks" / "task.py").write_text(PIPELINE)

        self.ids = [f"data/train/doc{index:03d}.{index % 2}" for index in range(ROWS)]
        self.labels = {row_id: index % 2 for index, row_id in enumerate(self.ids)}
        self.zip_path = self.root / "train.zip"
        with zipfile.ZipFile(self.zip_path, "w") as archive:
            for index, row_id in enumerate(self.ids):
                words = "free offer now" if index % 2 else "meeting agenda notes"
                archive.writestr(row_id, f"{words} number {index}")

        self.labels_path = self.root / "train.labels"
        self.labels_path.write_text("\n".join(f"{k};{v}" for k, v in self.labels.items()) + "\n")
        self.sealed_ids = self.ids[-SEALED:]
        self.sealed_path = self.root / "sealed_ids.txt"
        self.sealed_path.write_text("\n".join(self.sealed_ids) + "\n")

        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.dev_ids = self.ids[:-SEALED]

    def write(self, oof_ids):
        (self.workspace / "metrics.json").write_text(json.dumps({
            "schema_version": 1,
            "cv": {"scheme": "stratified_kfold", "folds": 2, "repeats": 1, "seed": 1},
            "entrypoint": {"module": "solutions/tasks/task.py", "factory": "build_pipeline"},
            "mean_bacc": 1.0,
            "approach": "test",
            "done": False,
        }))
        lines = ["id;repeat;fold;prediction"]
        for index, row_id in enumerate(oof_ids):
            lines.append(f"{row_id};0;{(index // 2) % 2};{self.labels.get(row_id, 0)}")
        (self.workspace / "oof_predictions.csv").write_text("\n".join(lines) + "\n")

    def evaluate(self):
        return evaluate(argparse.Namespace(
            workspace=str(self.workspace), project_root=str(self.root),
            labels=str(self.labels_path), sealed=str(self.sealed_path), zip=str(self.zip_path),
            seed=13, folds=2, bootstrap_resamples=50, session_seconds=1800.0,
            champion_module="", champion_factory="build_pipeline", champion_root="",
        ))

    def test_folds_that_hold_one_class_are_reported_as_unscorable(self):
        self.write(self.dev_ids)
        rows = ["id;repeat;fold;prediction"]
        for index, row_id in enumerate(self.dev_ids):
            rows.append(f"{row_id};0;{index % 2};{self.labels[row_id]}")
        (self.workspace / "oof_predictions.csv").write_text("\n".join(rows) + "\n")
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        self.assertIn("has to be stratified", "; ".join(signal["errors"]))

    def test_a_compliant_iteration_is_measurable(self):
        self.write(self.dev_ids)
        signal = self.evaluate()
        self.assertTrue(signal["ok"], signal["errors"])
        self.assertTrue(signal["coverage"]["complete"])
        self.assertIn("sealed", signal)
        self.assertTrue(signal["canary"]["passed"])
        self.assertEqual(signal["canary"]["kind"], "passed")

    def test_file_name_ids_are_named_as_a_formatting_mistake(self):
        self.write([row_id.rsplit("/", 1)[-1] for row_id in self.dev_ids])
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        joined = "; ".join(signal["errors"])
        self.assertIn("match a known row by file name", joined)
        self.assertIn("full path inside the archive", joined)

    def test_an_uncompliant_iteration_still_runs_the_canary(self):
        self.write([row_id.rsplit("/", 1)[-1] for row_id in self.dev_ids])
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        self.assertTrue(signal["canary"]["passed"])
        self.assertEqual(signal["canary"]["examples"], len(self.dev_ids))

    def test_partly_covered_rows_are_still_scored_and_marked_incomplete(self):
        self.write(self.dev_ids[:20])
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        self.assertIn("recomputed", signal)
        self.assertEqual(signal["coverage"]["scored"], 20)
        self.assertEqual(signal["coverage"]["development_rows"], len(self.dev_ids))
        self.assertFalse(signal["coverage"]["complete"])

    def test_a_partial_score_is_not_compared_against_the_reported_one(self):
        self.write(self.dev_ids[:20])
        signal = self.evaluate()
        self.assertEqual(signal["discrepancies"], [])

    def test_no_sealed_score_leaks_out_of_an_uncompliant_iteration(self):
        self.write(self.dev_ids[:20])
        self.assertNotIn("sealed", self.evaluate())

    def test_the_canary_fit_yields_a_cost_projection(self):
        self.write(self.dev_ids)
        cost = self.evaluate()["cost"]
        self.assertEqual(cost["fit_rows"], len(self.dev_ids))
        self.assertEqual(cost["development_rows"], len(self.dev_ids))
        self.assertEqual(cost["folds"], 2)
        self.assertGreater(cost["fit_seconds"], 0)
        # One fold trains on half the rows, and there are two of them.
        expected = cost["fit_seconds"] / cost["fit_rows"] * len(self.dev_ids)
        self.assertAlmostEqual(cost["estimated_cv_seconds"], expected, places=6)
        self.assertAlmostEqual(cost["share_of_session"], cost["estimated_cv_seconds"] / 1800.0, places=9)

    def test_cost_is_reported_even_when_the_iteration_is_unmeasurable(self):
        self.write([row_id.rsplit("/", 1)[-1] for row_id in self.dev_ids])
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        self.assertGreater(signal["cost"]["estimated_cv_seconds"], 0)

    def test_no_cost_is_projected_when_the_pipeline_never_fitted(self):
        self.write(self.dev_ids)
        (self.root / "solutions" / "tasks" / "task.py").unlink()
        signal = self.evaluate()
        self.assertEqual(signal["canary"]["kind"], "entrypoint_failed")
        self.assertNotIn("cost", signal)

    def test_a_broken_entrypoint_is_reported_as_such_not_as_leakage(self):
        self.write(self.dev_ids)
        (self.root / "solutions" / "tasks" / "task.py").write_text("def build_pipeline():\n    raise RuntimeError('boom')\n")
        signal = self.evaluate()
        self.assertFalse(signal["canary"]["passed"])
        self.assertEqual(signal["canary"]["kind"], "fit_failed")

    def test_a_missing_entrypoint_file_is_reported_as_such(self):
        self.write(self.dev_ids)
        (self.root / "solutions" / "tasks" / "task.py").unlink()
        signal = self.evaluate()
        self.assertEqual(signal["canary"]["kind"], "entrypoint_failed")

    def test_the_held_out_split_is_scored_without_any_agent_prediction(self):
        self.write(self.dev_ids)
        signal = self.evaluate()
        self.assertTrue(signal["ok"], signal["errors"])
        self.assertEqual(signal["sealed"]["n"], SEALED)
        self.assertGreaterEqual(signal["sealed"]["bacc"], 0.0)
        self.assertFalse((self.workspace / "confirmation_predictions.csv").exists())

    def test_a_missing_column_is_reported_before_the_row_counts(self):
        self.write(self.dev_ids)
        (self.workspace / "oof_predictions.csv").write_text("id;prediction\ndata/train/doc000.0;0\n")
        signal = self.evaluate()
        self.assertFalse(signal["ok"])
        self.assertEqual(len(signal["errors"]), 1)
        self.assertIn("missing the column(s) repeat, fold", signal["errors"][0])
        self.assertIn("canary", signal)


if __name__ == "__main__":
    unittest.main()
