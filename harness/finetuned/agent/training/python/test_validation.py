from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from smartlab_trial.validation import validate_request

PIPELINE = '''
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FunctionTransformer, Pipeline

def build_pipeline(context):
    parameters = context["parameters"]
    features = parameters.get("features", "word")
    if features not in ("word", "char"):
        raise ValueError(f"unknown features {features!r}")
    steps = [("text", FunctionTransformer(lambda frame: frame["text"], validate=False)),
             ("tfidf", TfidfVectorizer(analyzer="char" if features == "char" else "word"))]
    if parameters.get("scale"):
        from sklearn.preprocessing import MaxAbsScaler
        steps.append(("scale", MaxAbsScaler()))
    steps.append(("model", RandomForestClassifier()))
    return Pipeline(steps)
'''

SHAPE = {"path", "problem", "received", "expected", "hint"}


class Validation(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "solutions" / "tasks").mkdir(parents=True)
        (self.root / "solutions" / "tasks" / "spam1.py").write_text(PIPELINE, encoding="utf-8")

    def request(self, space=None, estimator_params=None, parameters=None, factory="build_pipeline"):
        pipeline = {"module": "solutions/tasks/spam1.py", "factory": factory, "parameters": parameters or {}}
        if estimator_params is not None:
            pipeline["estimatorParams"] = estimator_params
        request = {"schemaVersion": 2, "pipeline": pipeline,
                   "cv": {"kind": "builtin", "scheme": "stratified_kfold", "folds": 5, "repeats": 1}}
        if space is not None:
            request["search"] = {"space": space, "maxConfigs": 5}
        return request

    def assertShape(self, issues):
        for issue in issues:
            self.assertTrue(SHAPE.issubset(issue), issue)
            self.assertTrue(issue["hint"])

    def test_valid_search_and_fixed_parameters_pass_without_fitting(self):
        issues = validate_request(self.root, self.request(
            space={"model__max_depth": {"type": "int", "low": 4, "high": 40, "log": True},
                   "model__max_features": {"type": "categorical", "choices": ["sqrt", "log2", 0.3, None]},
                   "factory.features": {"type": "categorical", "choices": ["word", "char"]}},
            estimator_params={"model__n_estimators": 50}))
        self.assertEqual(issues, [])

    def test_unknown_parameter_suggests_the_closest_name_and_lists_the_step(self):
        issues = validate_request(self.root, self.request(space={"model__max_depht": {"type": "int", "low": 4, "high": 40}}))
        self.assertEqual(len(issues), 1)
        issue = issues[0]
        self.assertEqual(issue["path"], "search.space.model__max_depht")
        self.assertEqual(issue["problem"], "not a parameter of the pipeline")
        self.assertEqual(issue["expected"], "a name from the pipeline's get_params()")
        self.assertTrue(issue["hint"].startswith("Did you mean model__max_depth? Parameters of step 'model': "))
        self.assertIn("max_features", issue["hint"])

    def test_sklearn_constraints_reject_boundary_values_and_choices_with_verbatim_message(self):
        issues = validate_request(self.root, self.request(
            space={"model__max_features": {"type": "categorical", "choices": ["sqrt", "log2", 1.5]},
                   "model__min_samples_split": {"type": "int", "low": 1, "high": 10}},
            estimator_params={"model__n_estimators": 0}))
        self.assertShape(issues)
        by_path = {issue["path"]: issue for issue in issues}
        self.assertEqual(set(by_path), {"search.space.model__max_features.choices[2]",
                                        "search.space.model__min_samples_split.low",
                                        "pipeline.estimatorParams.model__n_estimators"})
        features = by_path["search.space.model__max_features.choices[2]"]
        self.assertEqual(features["problem"], "rejected by RandomForestClassifier")
        self.assertEqual(features["received"], 1.5)
        self.assertIn("a float in the range (0.0, 1.0]", features["expected"])
        self.assertEqual(features["hint"], "Use a fraction such as 0.5, or an integer count.")
        self.assertIn("The 'max_features' parameter of RandomForestClassifier must be", features["message"])
        self.assertIn("Got 1.5 instead", features["message"])

    def test_factory_values_are_checked_through_the_context(self):
        issues = validate_request(self.root, self.request(
            space={"factory.features": {"type": "categorical", "choices": ["word", "bigram"]}}))
        self.assertEqual([issue["path"] for issue in issues], ["search.space.factory.features.choices[1]"])
        self.assertEqual(issues[0]["problem"], "rejected by the factory")
        self.assertIn("unknown features 'bigram'", issues[0]["message"])

    def test_names_from_any_factory_variant_are_accepted(self):
        issues = validate_request(self.root, self.request(
            space={"factory.scale": {"type": "categorical", "choices": [False, True]},
                   "scale__copy": {"type": "categorical", "choices": [True, False]}}))
        self.assertEqual(issues, [])

    def test_missing_factory_and_import_errors_are_findings(self):
        issues = validate_request(self.root, self.request(factory="build_pipelin"))
        self.assertEqual(issues[0]["path"], "pipeline.factory")
        self.assertTrue(issues[0]["hint"].startswith("Did you mean build_pipeline?"))
        (self.root / "solutions" / "tasks" / "spam1.py").write_text("import not_a_module\n", encoding="utf-8")
        issues = validate_request(self.root, self.request())
        self.assertEqual(issues[0]["problem"], "could not be imported")
        self.assertIn("ModuleNotFoundError", issues[0]["message"])

    def test_fixed_factory_parameters_are_applied_when_building(self):
        issues = validate_request(self.root, self.request(parameters={"features": "trigram"}))
        self.assertEqual(issues[0]["problem"], "raised an error while building the pipeline")
        self.assertIn("unknown features 'trigram'", issues[0]["message"])

    def test_cli_reports_json_and_keeps_agent_prints_off_stdout(self):
        (self.root / "solutions" / "tasks" / "spam1.py").write_text("print('noise')\n" + PIPELINE, encoding="utf-8")
        script = Path(__file__).resolve().parent / "validate.py"
        result = subprocess.run([sys.executable, str(script)], capture_output=True, text=True,
                                input=json.dumps({"sourceRoot": str(self.root), "request": self.request()}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"issues": []})
        self.assertIn("noise", result.stderr)

    def test_fixed_factory_values_validate_constructed_estimator_constraints(self):
        (self.root / "solutions/tasks/spam1.py").write_text(
            "from sklearn.ensemble import RandomForestClassifier\n"
            "def build_pipeline(context):\n"
            "    return RandomForestClassifier(n_estimators=context['parameters']['trees'])\n")
        issues = validate_request(self.root, self.request(parameters={"trees": 0}))
        self.assertShape(issues)
        self.assertEqual(issues[0]["path"], "pipeline.parameters")
        self.assertIn("Got 0 instead", issues[0]["message"])


if __name__ == "__main__":
    unittest.main()
