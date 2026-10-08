from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

import numpy as np
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from smartlab_trial.id_leakage import check, neutral_validation


class Detector:
    def __init__(self, feature="bytes", score_only=False):
        self.feature, self.score_only = feature, score_only
        self.classes_ = np.array([0, 1])

    def values(self, frame):
        if self.feature == "id":
            return np.array([str(value).endswith(".1") for value in frame["id"]], dtype=int)
        if self.feature == "member":
            return np.array([value["member"].endswith(".1") for value in frame["input"]], dtype=int)
        return np.array([int(ZipFile(value["archive"]).read(value["member"])) for value in frame["input"]])

    def predict(self, frame):
        return Detector().values(frame) if self.score_only else self.values(frame)

    def predict_proba(self, frame):
        values = Detector().values(frame)
        scores = .2 + .6 * values + (.05 * self.values(frame) if self.score_only else 0)
        return np.column_stack([1 - scores, scores])


class IdentityCanary(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.archive = Path(self.directory.name) / "raw.zip"
        with ZipFile(self.archive, "w") as archive:
            archive.writestr("same.0", b"0")
            archive.writestr("same.1", b"1")
        self.frame = pd.DataFrame([{"id": name, "input": {"archive": str(self.archive), "member": name}}
                                   for name in ("same.0", "same.1")])

    def test_bytes_preserved_and_all_accessible_member_names_neutral(self):
        with neutral_validation(self.frame) as neutral:
            self.assertEqual([value["member"].split("/")[-1] for value in neutral["input"]], ["same.x", "same.x"])
            self.assertEqual(Detector().values(neutral).tolist(), [0, 1])
            with ZipFile(neutral.iloc[0]["input"]["archive"]) as archive:
                self.assertTrue(all(name.endswith(".x") for name in archive.namelist()))

    def test_identity_predictors_rejected(self):
        for feature in ("id", "member"):
            detector = Detector(feature)
            self.assertEqual(check(detector, self.frame, detector.predict(self.frame), detector.predict_proba(self.frame)[:, 1]),
                             {"rows": 2, "mismatches": 1})

    def test_score_only_leakage_rejected_with_unchanged_labels(self):
        for feature in ("id", "member"):
            detector = Detector(feature, score_only=True)
            self.assertEqual(check(detector, self.frame, detector.predict(self.frame), detector.predict_proba(self.frame)[:, 1]),
                             {"rows": 2, "mismatches": 1})

    def test_champion_leakage_invalidates_paired_comparison(self):
        from smartlab_trial.champion import compare
        result = compare([], [], {"experimentId": "old", "commit": "abc", "folds": [
            {"idLeakage": {"rows": 2, "mismatches": 1}}]}, {}, Path(self.directory.name))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "id_leakage")

    def test_content_only_is_silent(self):
        detector = Detector()
        self.assertIsNone(check(detector, self.frame, detector.predict(self.frame), detector.predict_proba(self.frame)[:, 1]))


if __name__ == "__main__":
    unittest.main()
