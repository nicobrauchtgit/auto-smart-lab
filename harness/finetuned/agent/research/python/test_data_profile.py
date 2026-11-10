"""Harness data profile on synthetic archives: generic records, leakage, duplicates, text layer."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_profile  # noqa: E402

SCRIPT = Path(__file__).resolve().parent / "data_profile.py"


def write_zip(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)


class DataProfileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        spam = b"<html><body><a href='http://x.example'>buy</a> http://y.example</body></html>"
        ham = b"From: a@example.org\nSubject: hello\n\nsee you tomorrow\n"
        train = {f"data/train/s{i}.1": spam + str(i).encode() for i in range(4)}
        train |= {f"data/train/h{i}.0": ham + str(i).encode() for i in range(6)}
        train["data/train/dup.0"] = ham + b"0"  # duplicates h0, same target
        train["data/train/conflict.1"] = ham + b"1"  # duplicates h1, different target
        test = {f"data/test/t{i}.x": (spam if i % 2 else ham) + f"test{i}".encode() for i in range(5)}
        test["data/test/copy.x"] = spam + b"0"  # exact copy of a training member
        write_zip(root / "train.zip", train)
        write_zip(root / "test.zip", test)
        (root / "train.labels").write_text("".join(f"{name};{name[-1]}\n" for name in train))
        self.spec = {"trainZip": str(root / "train.zip"), "testZip": str(root / "test.zip"),
                     "targetsPath": str(root / "train.labels"), "targets": "binary", "source": "zip_members",
                     "datasetSnapshotSha256": "abc"}
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def test_records_are_citeable_and_compact(self):
        result = data_profile.profile(self.spec)
        self.assertEqual(result["dataset_snapshot_sha256"], "abc")
        self.assertEqual(result["layers"], ["generic", "text"])
        for key, record in result["evidence"].items():
            self.assertEqual(record["scope"], "full", key)
            self.assertGreaterEqual(record["population"], 1, key)
            self.assertTrue(record["method"].strip(), key)
            self.assertIn("values", record, key)
        text = json.dumps(result)
        self.assertNotIn("data/train/", text, "member names must not be stored")
        self.assertNotIn("buy", text, "sample contents must not be stored")

    def test_leakage_duplicates_and_text_layer(self):
        evidence = data_profile.profile(self.spec)["evidence"]
        self.assertEqual(evidence["training.targets"]["values"]["counts"], {"0": 7, "1": 5})
        suffix = evidence["training.name_leakage"]["values"]["suffix"]
        self.assertEqual(suffix["majority_accuracy"], 1.0)
        self.assertEqual(suffix["key_equals_target_fraction"], 1.0)
        self.assertEqual(evidence["training.name_leakage"]["values"]["test_suffixes_distinct"], 1)
        self.assertEqual(evidence["training.duplicates"]["values"]["duplicate_groups"], 2)
        self.assertEqual(evidence["training.duplicate_target_conflicts"]["values"]["conflicting_groups"], 1)
        self.assertEqual(evidence["training_vs_test.exact_overlap"]["values"]["test_samples_matching_training"], 1)
        self.assertEqual(evidence["training.content_types"]["values"]["categories"], {"email": 8, "html": 4})
        by_target = evidence["training.text_by_target"]["values"]
        self.assertEqual(by_target["1"]["html_rate"], 0.8)  # conflict.1 is an email
        self.assertEqual(by_target["1"]["urls_median"], 2)

    def test_binary_members_skip_text_layer(self):
        write_zip(self.root / "test.zip", {f"data/test/b{i}.x": b"MZ\x90\x00" + bytes(range(256)) for i in range(3)})
        result = data_profile.profile(self.spec)
        self.assertEqual(result["layers"], ["generic"])
        self.assertEqual(result["evidence"]["test.content_types"]["values"]["categories"], {"pe": 3})

    def test_label_free_task_has_no_target_records(self):
        result = data_profile.profile({**self.spec, "targets": "none", "targetsPath": None})
        self.assertFalse([key for key in result["evidence"] if "target" in key or "leakage" in key])

    def test_cli_reports_errors_without_writing(self):
        out = self.root / "profile.json"
        done = subprocess.run([sys.executable, str(SCRIPT), "--spec", json.dumps({**self.spec, "trainZip": str(self.root / "missing.zip")}),
                               "--out", str(out)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn("error", json.loads(done.stdout))
        self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
