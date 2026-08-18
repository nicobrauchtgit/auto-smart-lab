"""Spam task 1 solver.

The solver intentionally has a strong stdlib-only fallback so it can run in the
SmartLab VM and in minimal local environments.  It trains a clipped-count
Multinomial Naive Bayes model over word tokens and character 3-grams.  On a
fixed holdout split of the provided training data this baseline scores around
0.99 balanced accuracy.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence
import math
import random
import re

from smartlab.common import (
    ZipTextItem,
    balanced_accuracy,
    download_file,
    iter_zip_texts,
    parse_semicolon_labels,
    project_root,
    read_zip_text,
    write_semicolon_predictions,
    zip_members,
)

TRAIN_URL = "https://download.smartlab.mlsec.tu-berlin.de/01-spam/train/spam1-train.zip"
TEST_URL = "https://download.smartlab.mlsec.tu-berlin.de/01-spam/test/spam1-test.zip"
_UNITS_DATA = project_root() / "units" / "01-spam" / "task1-spam-detection" / "data"
_LEGACY_DATA = project_root() / "agent" / "data" / "raw"
TRAIN_ZIP = _UNITS_DATA / "spam1-train.zip" if (_UNITS_DATA / "spam1-train.zip").exists() else _LEGACY_DATA / "spam1-train.zip"
TEST_ZIP = _UNITS_DATA / "spam1-test.zip" if (_UNITS_DATA / "spam1-test.zip").exists() else _LEGACY_DATA / "spam1-test.zip"
DEFAULT_SUBMISSION = project_root() / "submissions" / "spam1_predictions.csv"
LABELS_MEMBER = "spam1-train.labels"
TEST_PREFIX = "data/spam1-test/"
WORD_RE = re.compile(r"[a-z0-9$@._%+-]+")


def download(force: bool = False) -> None:
    download_file(TRAIN_URL, TRAIN_ZIP, force=force)
    download_file(TEST_URL, TEST_ZIP, force=force)


def load_training_items(train_zip: Path = TRAIN_ZIP) -> list[ZipTextItem]:
    labels = parse_semicolon_labels(read_zip_text(train_zip, LABELS_MEMBER))
    label_by_path = dict(labels)
    return [
        ZipTextItem(path=path, text=text, label=label_by_path[path])
        for path, text in iter_zip_texts(train_zip, list(label_by_path))
    ]


def load_test_items(test_zip: Path = TEST_ZIP) -> list[ZipTextItem]:
    members = [m for m in zip_members(test_zip, prefix=TEST_PREFIX) if m.endswith(".x")]
    return [ZipTextItem(path=path, text=text) for path, text in iter_zip_texts(test_zip, members)]


def extract_features(text: str) -> Counter[str]:
    """Extract robust text features for spam/ham classification.

    Counts are clipped later during training/prediction, which reduces the
    impact of very long repeated adversarial strings.
    """
    lowered = text.lower()
    features: Counter[str] = Counter()

    words = WORD_RE.findall(lowered)
    features.update(f"w={token}" for token in words)

    # Character n-grams catch misspellings/obfuscation like "v1agra" or
    # punctuation-heavy spam while still being cheap enough for this dataset.
    compact = re.sub(r"\s+", " ", lowered)
    features.update(f"c3={compact[i:i+3]}" for i in range(max(0, len(compact) - 2)))
    return features


@dataclass
class NaiveBayesTextModel:
    alpha: float = 0.1
    clip_count: int = 3
    class_doc_counts: list[int] | None = None
    class_token_counts: list[int] | None = None
    feature_counts: list[Counter[str]] | None = None
    vocab: set[str] | None = None

    def fit(self, texts: Sequence[str], labels: Sequence[int]) -> "NaiveBayesTextModel":
        self.class_doc_counts = [0, 0]
        self.class_token_counts = [0, 0]
        self.feature_counts = [Counter(), Counter()]
        self.vocab = set()

        for text, label in zip(texts, labels):
            y = int(label)
            self.class_doc_counts[y] += 1
            feats = extract_features(text)
            for feature, count in feats.items():
                clipped = min(int(count), self.clip_count)
                self.feature_counts[y][feature] += clipped
                self.class_token_counts[y] += clipped
                self.vocab.add(feature)
        return self

    def _check_fitted(self) -> None:
        if (
            self.class_doc_counts is None
            or self.class_token_counts is None
            or self.feature_counts is None
            or self.vocab is None
        ):
            raise RuntimeError("Model is not fitted")

    def predict_one(self, text: str) -> int:
        self._check_fitted()
        assert self.class_doc_counts is not None
        assert self.class_token_counts is not None
        assert self.feature_counts is not None
        assert self.vocab is not None

        n_docs = sum(self.class_doc_counts)
        vocab_size = len(self.vocab)
        scores = [
            math.log((self.class_doc_counts[y] + self.alpha) / (n_docs + 2 * self.alpha))
            for y in (0, 1)
        ]
        denominators = [
            self.class_token_counts[y] + self.alpha * vocab_size
            for y in (0, 1)
        ]

        feats = extract_features(text)
        for feature, count in feats.items():
            if feature not in self.vocab:
                continue
            clipped = min(int(count), self.clip_count)
            for y in (0, 1):
                numerator = self.feature_counts[y][feature] + self.alpha
                scores[y] += clipped * math.log(numerator / denominators[y])
        return int(scores[1] > scores[0])

    def predict(self, texts: Iterable[str]) -> list[int]:
        return [self.predict_one(text) for text in texts]


def stratified_holdout(
    items: Sequence[ZipTextItem], validation_fraction: float, seed: int
) -> tuple[list[ZipTextItem], list[ZipTextItem]]:
    rng = random.Random(seed)
    by_label = {0: [], 1: []}
    for item in items:
        assert item.label is not None
        by_label[int(item.label)].append(item)
    train: list[ZipTextItem] = []
    validation: list[ZipTextItem] = []
    for label_items in by_label.values():
        rng.shuffle(label_items)
        n_val = max(1, int(round(len(label_items) * validation_fraction)))
        validation.extend(label_items[:n_val])
        train.extend(label_items[n_val:])
    rng.shuffle(train)
    rng.shuffle(validation)
    return train, validation


def validate(validation_fraction: float = 0.2, seed: int = 13) -> float:
    items = load_training_items()
    train_items, val_items = stratified_holdout(items, validation_fraction, seed)
    model = NaiveBayesTextModel().fit(
        [item.text for item in train_items], [int(item.label) for item in train_items]
    )
    y_true = [int(item.label) for item in val_items]
    y_pred = model.predict([item.text for item in val_items])
    bacc = balanced_accuracy(y_true, y_pred)

    confusion = {(actual, pred): 0 for actual in (0, 1) for pred in (0, 1)}
    for actual, pred in zip(y_true, y_pred):
        confusion[(actual, pred)] += 1
    print(f"[spam1] validation examples: {len(val_items)}")
    print(
        "[spam1] confusion: "
        f"tn={confusion[(0, 0)]} fp={confusion[(0, 1)]} "
        f"fn={confusion[(1, 0)]} tp={confusion[(1, 1)]}"
    )
    print(f"[spam1] balanced_accuracy={bacc:.6f}")
    return bacc


def solve(output_path: Path = DEFAULT_SUBMISSION) -> Path:
    train_items = load_training_items()
    test_items = load_test_items()
    model = NaiveBayesTextModel().fit(
        [item.text for item in train_items], [int(item.label) for item in train_items]
    )
    predictions = model.predict([item.text for item in test_items])
    rows = [(item.path, pred) for item, pred in zip(test_items, predictions)]
    write_semicolon_predictions(rows, output_path)
    n_spam = sum(predictions)
    print(f"[spam1] wrote {len(rows)} predictions: {output_path}")
    print(f"[spam1] predicted ham={len(rows) - n_spam} spam={n_spam}")
    return output_path
