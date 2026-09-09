"""The corpus loader the harness and the solve agent share."""
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


from smartlab_eval import corpus_ids, load_corpus, load_labelled, load_labels


class Corpus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp())
        cls.zip_path = cls.root / "train.zip"
        cls.members = [f"data/train/doc{index:03d}.{index % 2}" for index in range(20)]
        with zipfile.ZipFile(cls.zip_path, "w") as archive:
            for index, member in enumerate(cls.members):
                archive.writestr(member, f"document number {index}")
        cls.labels_path = cls.root / "train.labels"
        cls.labels_path.write_text(
            "\n".join(f"{member};{index % 2}" for index, member in enumerate(cls.members)) + "\n",
        )

    def test_reads_every_member_in_archive_order(self):
        frame = load_corpus(self.zip_path)
        self.assertEqual(list(frame["id"]), self.members)
        self.assertEqual(frame["text"].iloc[0], "document number 0")

    def test_selected_ids_keep_the_order_they_were_asked_for(self):
        wanted = [self.members[5], self.members[1], self.members[9]]
        frame = load_corpus(self.zip_path, wanted)
        self.assertEqual(list(frame["id"]), wanted)

    def test_reports_what_the_load_cost(self):
        frame = load_corpus(self.zip_path)
        cost = frame.attrs["corpus_load"]
        self.assertEqual(cost["rows"], len(self.members))
        self.assertGreater(cost["seconds"], 0)

    def test_a_file_name_in_place_of_an_id_names_the_mistake(self):
        with self.assertRaises(KeyError) as caught:
            load_corpus(self.zip_path, ["doc003.1"])
        message = str(caught.exception)
        self.assertIn("match a known row by file name", message)
        self.assertIn("data/train/doc003.1", message)

    def test_an_id_that_matches_nothing_says_only_that(self):
        with self.assertRaises(KeyError) as caught:
            load_corpus(self.zip_path, ["data/train/absent.0"])
        self.assertNotIn("by file name", str(caught.exception))

    def test_corpus_ids_matches_the_loaded_frame(self):
        self.assertEqual(corpus_ids(self.zip_path), list(load_corpus(self.zip_path)["id"]))

    def test_labels_are_read_as_full_paths(self):
        labels = load_labels(self.labels_path)
        self.assertEqual(len(labels), len(self.members))
        self.assertEqual(labels[self.members[3]], 1)

    def test_labelled_rows_come_back_aligned_and_without_the_target(self):
        frame, y = load_labelled(self.zip_path, self.labels_path)
        self.assertEqual(list(frame.columns), ["id", "text"])
        self.assertEqual(len(frame), len(y))
        self.assertEqual([label for label in y], [index % 2 for index in range(len(self.members))])

    def test_an_unlabelled_id_is_refused_before_the_archive_is_read(self):
        with self.assertRaises(KeyError) as caught:
            load_labelled(self.zip_path, self.labels_path, ["data/train/absent.0"])
        self.assertIn("no label", str(caught.exception))

    def test_a_malformed_labels_row_names_its_line(self):
        broken = self.root / "broken.labels"
        broken.write_text("data/train/doc000.0;0\ndata/train/doc001.1;maybe\n")
        with self.assertRaises(ValueError) as caught:
            load_labels(broken)
        self.assertIn("line 2", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
