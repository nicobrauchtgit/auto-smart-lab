from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
from dataclasses import FrozenInstanceError
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import worker
from smartlab_trial.invocation import parse_invocation
from smartlab_trial.seeds import _derive_seed


PIPELINE = '''
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, FunctionTransformer

def build_pipeline(context):
    return Pipeline([
        ("text", FunctionTransformer(lambda frame: frame["text"], validate=False)),
        ("tfidf", TfidfVectorizer()),
        ("model", LogisticRegression(max_iter=context["parameters"].get("max_iter", 100))),
    ])
'''

CUSTOM_CV = '''
def make_cv(context):
    assert "frame" in context and "y" in context and "seed" in context
    n = len(context["y"])
    middle = n // 2
    return [
        (list(range(middle, n)), list(range(0, middle))),
        (list(range(0, middle)), list(range(middle, n))),
    ]
'''


class Worker(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "solutions").mkdir()
        (self.root / "solutions" / "pipeline.py").write_text(PIPELINE, encoding="utf-8")
        (self.root / "solutions" / "custom_cv.py").write_text(CUSTOM_CV, encoding="utf-8")
        self.ids = [f"data/train/doc{index:03d}.{index % 2}" for index in range(24)]
        self.zip_path = self.root / "train.zip"
        with zipfile.ZipFile(self.zip_path, "w") as archive:
            for index, row_id in enumerate(reversed(self.ids)):
                label = int(row_id.rsplit(".", 1)[1])
                text = ("limited offer prize" if label else "project meeting agenda") + f" token{index}"
                archive.writestr(row_id, text)
        self.labels_path = self.root / "train.labels"
        # Deliberately reverse input order; manifests are ID-order stable.
        self.labels_path.write_text(
            "\n".join(f"{row_id};{row_id.rsplit('.', 1)[1]}" for row_id in reversed(self.ids)) + "\n",
            encoding="utf-8",
        )

    def invocation(self, name="run", *, scope=None, cv=None):
        return {
            "schemaVersion": 1,
            "experimentId": name,
            "request": {
                "schemaVersion": 1,
                "hypothesis": "word choice separates classes",
                "pipeline": {
                    "module": "solutions/pipeline.py",
                    "factory": "build_pipeline",
                    "parameters": {"max_iter": 80},
                },
                "cv": cv or {
                    "kind": "builtin", "scheme": "stratified_kfold", "folds": 3, "repeats": 2
                },
                "scope": scope or {"kind": "promotion"},
            },
            "inputs": {
                "projectRoot": str(self.root),
                "zipPath": str(self.zip_path),
                "labelsPath": str(self.labels_path),
                "outputDir": str(self.root / name),
            },
            "seeds": {"experiment": 1776},
        }

    def read_json(self, run, name):
        return json.loads((self.root / run / name).read_text(encoding="utf-8"))

    def test_seed_derivation_matches_the_persisted_typescript_plan(self):
        fixture = json.loads((Path(__file__).parents[1] / "seed-vectors.json").read_text())
        trial = _derive_seed("trial", [fixture["experimentSeed"], fixture["trial"]])
        repeat = _derive_seed("repeat", [trial, fixture["repeat"]])
        fold = _derive_seed("fold", [repeat, fixture["fold"]])
        estimator = _derive_seed("estimator", [fold, fixture["estimator"]])
        self.assertEqual([trial, repeat, fold, estimator], fixture["expected"])

    def test_builtin_promotion_is_deterministic_and_complete(self):
        first = worker.execute(self.invocation("first"))
        second = worker.execute(self.invocation("second"))
        self.assertEqual(first["status"], "completed")
        self.assertTrue(first["promotionEligible"])
        self.assertEqual(first["completedFolds"], 6)
        first_manifest = self.read_json("first", "fold-manifest.json")
        second_manifest = self.read_json("second", "fold-manifest.json")
        # Experiment ID is metadata; assignments and derived seeds are stable.
        self.assertEqual(first_manifest["assignments"], second_manifest["assignments"])
        self.assertEqual(first_manifest["folds"], second_manifest["folds"])
        self.assertEqual(len(first_manifest["assignments"]), len(self.ids) * 2)
        for repeat in range(2):
            ids = [row["id"] for row in first_manifest["assignments"] if row["repeat"] == repeat]
            self.assertCountEqual(ids, self.ids)
        oof = (self.root / "first" / "oof_predictions.csv").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(oof), 1 + len(self.ids) * 2)
        self.assertEqual(first["metrics"]["balancedAccuracy"], 1.0)
        fold_rows = (self.root / "first" / "fold-results.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(fold_rows), 6)

    def test_custom_splitter_is_materialized_before_training(self):
        invocation = self.invocation("custom", cv={
            "kind": "factory",
            "module": "solutions/custom_cv.py",
            "factory": "make_cv",
            "repeats": 1,
            "options": {"anything": True},
        })
        result = worker.execute(invocation)
        self.assertTrue(result["promotionEligible"])
        manifest = self.read_json("custom", "fold-manifest.json")
        self.assertEqual(manifest["foldCount"], 2)
        events = [json.loads(line) for line in (self.root / "custom" / "events.jsonl").read_text().splitlines()]
        types = [event["type"] for event in events]
        self.assertLess(types.index("folds_materialized"), types.index("fold_started"))

    def test_zero_argument_pipeline_factory_remains_compatible(self):
        (self.root / "solutions" / "zero.py").write_text(
            PIPELINE.replace("def build_pipeline(context):", "def build_pipeline():")
            .replace('context["parameters"].get("max_iter", 100)', "100"),
            encoding="utf-8",
        )
        invocation = self.invocation("zero", scope={"kind": "pilot", "maxFolds": 1})
        invocation["request"]["pipeline"]["module"] = "solutions/zero.py"
        result = worker.execute(invocation)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["completedFolds"], 1)
        fold = json.loads((self.root / "zero" / "fold-results.jsonl").read_text())
        self.assertIn("model__random_state", fold["seededParameters"])

    def test_pilot_subset_and_partial_folds_are_never_promotion_eligible(self):
        result = worker.execute(self.invocation(
            "pilot",
            scope={"kind": "pilot", "maxRows": 12, "maxFolds": 1},
        ))
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["promotionEligible"])
        self.assertEqual(result["rows"], 12)
        self.assertEqual(result["completedFolds"], 1)
        manifest = self.read_json("pilot", "fold-manifest.json")
        selected_labels = [int(row["id"].rsplit(".", 1)[1]) for row in manifest["assignments"]]
        self.assertEqual(set(selected_labels), {0, 1})

    def test_promotion_rejects_incomplete_custom_coverage_before_fit(self):
        (self.root / "solutions" / "bad_cv.py").write_text(
            "def make_cv(context):\n return [([0, 1], [2, 3])]\n", encoding="utf-8"
        )
        invocation = self.invocation("bad", cv={
            "kind": "factory", "module": "solutions/bad_cv.py", "factory": "make_cv", "repeats": 1
        })
        with self.assertRaisesRegex(worker.InvocationError, "validate every row exactly once"):
            worker.execute(invocation)
        self.assertFalse((self.root / "bad" / "fold-manifest.json").exists())
        self.assertFalse((self.root / "bad" / "fold-results.jsonl").exists())

    def test_stop_before_first_fit_preserves_manifest_and_is_not_eligible(self):
        original = worker._materialize_folds

        def request_stop(*args, **kwargs):
            folds = original(*args, **kwargs)
            worker._handle_stop(15, None)
            return folds

        worker._materialize_folds = request_stop
        try:
            result = worker.execute(self.invocation("stopped"))
        finally:
            worker._materialize_folds = original
            worker._stop_requested = False
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["completedFolds"], 0)
        self.assertFalse(result["promotionEligible"])
        self.assertTrue((self.root / "stopped" / "fold-manifest.json").is_file())
        self.assertFalse((self.root / "stopped" / "fold-results.jsonl").exists())

    def test_manifest_hashes_match_pre_refactor_fixtures(self):
        cases = [
            ("first", {}, "732c7ec2411a1861c16034ff05d8d8b7f973e9794524039d149aa73946574098"),
            ("pilot", {"scope": {"kind": "pilot", "maxRows": 12, "maxFolds": 1}},
             "95553c3ef60d2d5f567b24b5394541a308e4af2eeabdd076a4d3c81040c20cf8"),
            ("custom", {"cv": {"kind": "factory", "module": "solutions/custom_cv.py",
                               "factory": "make_cv", "repeats": 1, "options": {"anything": True}}},
             "005c129bf8cacd64b5bcb6f4ad478a0980428b4b8cb77dd1defe38eb600d2dff"),
        ]
        for name, options, expected in cases:
            with self.subTest(name=name), contextlib.redirect_stdout(io.StringIO()):
                worker.execute(self.invocation(name, **options))
                self.assertEqual(self.read_json(name, "fold-manifest.json")["sha256"], expected)
                self.assertEqual((self.root / name / "metrics.json").read_bytes(),
                                 (self.root / name / "trial-result.json").read_bytes())

    def test_typed_defaults_and_explicit_trial_seed(self):
        document = self.invocation()
        del document["request"]["cv"]["repeats"]
        parsed = parse_invocation(document)
        self.assertEqual(parsed.cv.repeats, 1)
        self.assertEqual(parsed.trial_seed, _derive_seed("trial", [1776, 0]))
        self.assertIsNone(parsed.scope.max_rows)
        with self.assertRaises(FrozenInstanceError):
            parsed.cv.repeats = 4
        document["seeds"]["trial"] = 0
        self.assertEqual(parse_invocation(document).trial_seed, 0)
        document["request"]["cv"]["repeats"] = 0
        with self.assertRaisesRegex(worker.InvocationError, "repeats"):
            parse_invocation(document)

    def test_cli_preserves_agent_helper_imports_and_logs_actions(self):
        for name in ("metrics", "folds", "seeds", "artifacts", "invocation", "agent_code"):
            (self.root / f"{name}.py").write_text("AGENT_HELPER = True\n")
        imports = "\n".join(f"import {name}\nassert {name}.AGENT_HELPER" for name in
                            ("metrics", "folds", "seeds", "artifacts", "invocation", "agent_code"))
        (self.root / "solutions/pipeline.py").write_text(imports + "\n" + PIPELINE)
        invocation = self.root / "invocation.json"
        invocation.write_text(json.dumps(self.invocation("cli", scope={"kind": "pilot", "maxFolds": 1})))
        result = subprocess.run([sys.executable, str(Path(worker.__file__).resolve()),
                                 "--invocation", str(invocation)], capture_output=True, text=True,
                                env={**os.environ, "PIPELINE_RUN_ID": "pipeline-fixture",
                                     "PIPELINE_STAGE_INVOCATION_ID": "invocation-fixture"})
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in (self.root / "cli/events.jsonl").read_text().splitlines()]
        self.assertTrue(all(event["experimentId"] == "cli" for event in events))
        self.assertTrue(all(event["pipelineRunId"] == "pipeline-fixture" and
                            event["stageInvocationId"] == "invocation-fixture" for event in events))
        for stage in ("data", "folds", "agent_code", "fit", "metrics", "artifacts"):
            actions = [event["type"] for event in events if event.get("stage") == stage]
            self.assertEqual(actions, ["action_started", "action_completed"] * (2 if stage == "artifacts" else 1))
        self.assertEqual(events, [json.loads(line) for line in result.stdout.splitlines()])

    def test_failed_action_is_logged_without_promotion_artifacts(self):
        (self.root / "solutions/pipeline.py").write_text("raise RuntimeError('fixture failure')\n")
        with self.assertRaisesRegex(RuntimeError, "fixture failure"):
            worker.execute(self.invocation("failure"))
        events = [json.loads(line) for line in (self.root / "failure/events.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["type"], "action_failed")
        self.assertEqual(events[-1]["stage"], "agent_code")
        self.assertEqual(events[-1]["error"]["message"], "fixture failure")
        self.assertFalse((self.root / "failure/metrics.json").exists())


if __name__ == "__main__":
    unittest.main()
