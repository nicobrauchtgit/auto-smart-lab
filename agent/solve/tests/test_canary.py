"""The leakage canary against pipelines that do and do not read the filename."""
import random
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from solve.canary import run_canary
from solve.entrypoint import load_factory

CLEAN = '''
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, FunctionTransformer

def build_pipeline():
    return Pipeline([
        ("text", FunctionTransformer(lambda frame: frame["text"], validate=False)),
        ("tfidf", TfidfVectorizer()),
        ("model", LogisticRegression(max_iter=500, random_state=0)),
    ])
'''

# Folds the label-bearing extension into the text as a token the vectorizer keeps.
LEAKY = '''
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline, FunctionTransformer

def _cheat(frame):
    return "ext" + frame["id"].str.rsplit(".", n=1).str[-1] + " " + frame["text"]

def build_pipeline():
    return Pipeline([
        ("cheat", FunctionTransformer(_cheat, validate=False)),
        ("tfidf", TfidfVectorizer()),
        ("model", LogisticRegression(max_iter=500, random_state=0)),
    ])
'''


class Canary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp())
        (cls.root / "solutions" / "tasks").mkdir(parents=True)
        (cls.root / "solutions" / "tasks" / "clean.py").write_text(CLEAN)
        (cls.root / "solutions" / "tasks" / "leaky.py").write_text(LEAKY)
        random.seed(3)
        cls.ids, cls.labels = [], []
        cls.zip_path = cls.root / "train.zip"
        with zipfile.ZipFile(cls.zip_path, "w") as archive:
            for index in range(200):
                label = index % 2
                strong = ["free", "offer"] if label else ["report", "agenda"]
                shared = ["the", "and", "please", "today"]
                words = [random.choice(strong) if random.random() < 0.25 else random.choice(shared)
                         for _ in range(30)]
                name = f"data/t-train/{index:05d}.{label}"
                archive.writestr(name, " ".join(words))
                cls.ids.append(name)
                cls.labels.append(label)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def _run(self, module):
        return run_canary(self.root, self.zip_path, f"solutions/tasks/{module}.py",
                          "build_pipeline", self.ids, self.labels, seed=3)

    def test_a_content_only_pipeline_passes(self):
        result = self._run("clean")
        self.assertTrue(result.passed, result.reason)
        self.assertEqual(result.examples, 200)

    def test_a_pipeline_reading_the_filename_fails(self):
        result = self._run("leaky")
        self.assertFalse(result.passed)
        self.assertIn("filename", result.reason)

    def test_dotted_modules_preserve_the_canary_verdict(self):
        # The verdict, not the whole record: `fit_seconds` is a wall-clock
        # measurement and differs between two runs of identical code.
        verdict = lambda result: (result.passed, result.reason, result.examples, result.kind)
        for module in ("clean", "leaky"):
            with self.subTest(module=module):
                result = run_canary(self.root, self.zip_path, f"solutions.tasks.{module}",
                                    "build_pipeline", self.ids, self.labels, seed=3)
                self.assertEqual(verdict(result), verdict(self._run(module)))

    def test_a_successful_canary_reports_what_the_fit_cost(self):
        result = self._run("clean")
        self.assertGreater(result.fit_seconds, 0)
        self.assertEqual(result.as_dict()["fit_seconds"], result.fit_seconds)

    def test_catches_a_leak_that_changes_no_prediction(self):
        """The sharp case: content alone already separates these classes, so the
        leaky pipeline predicts exactly what the clean one does. Comparing hard
        labels would call this clean; comparing scores catches the leak."""
        import pandas as pd
        from solve.corpus import load_examples, neutralize_ids

        frame = load_examples(self.zip_path, self.ids)
        leaky = load_factory(self.root, "solutions/tasks/leaky.py", "build_pipeline")
        real, neutral = frame, neutralize_ids(frame)
        same = (leaky().fit(real, self.labels).predict(real)
                == leaky().fit(neutral, self.labels).predict(neutral))
        self.assertTrue(bool(pd.Series(same).all()), "fixture no longer exercises the subtle case")
        self.assertFalse(self._run("leaky").passed)

    def test_a_missing_module_is_reported_not_raised(self):
        result = self._run("absent")
        self.assertFalse(result.passed)
        self.assertIn("could not load entrypoint", result.reason)

    def test_a_missing_factory_is_reported_not_raised(self):
        result = run_canary(self.root, self.zip_path, "solutions/tasks/clean.py",
                            "no_such_factory", self.ids, self.labels)
        self.assertFalse(result.passed)
        self.assertIn("could not load entrypoint", result.reason)


class EntrypointLoading(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "solutions").mkdir()
        (self.root / "solutions" / "ok.py").write_text("def build_pipeline():\n    return 'built'\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_loads_a_factory(self):
        for module in ("solutions/ok.py", "solutions.ok", "solutions/ok"):
            with self.subTest(module=module):
                self.assertEqual(load_factory(self.root, module, "build_pipeline")(), "built")

    def test_preserves_dots_in_explicit_python_paths(self):
        (self.root / "solutions" / "version.3.py").write_text("def build_pipeline():\n    return 'v3'\n")
        self.assertEqual(load_factory(self.root, "solutions/version.3.py", "build_pipeline")(), "v3")

    def test_refuses_a_module_outside_the_project(self):
        with self.assertRaisesRegex((ValueError, FileNotFoundError), "escapes|does not exist"):
            load_factory(self.root, "../outside.py", "build_pipeline")

    def test_reports_a_non_callable_attribute(self):
        (self.root / "solutions" / "bad.py").write_text("build_pipeline = 5\n")
        with self.assertRaises(TypeError):
            load_factory(self.root, "solutions/bad.py", "build_pipeline")


if __name__ == "__main__":
    unittest.main()
