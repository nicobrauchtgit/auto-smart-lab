"""Solver for spam3 — webspam detection (HTML web pages)."""
from __future__ import annotations

import math
import re
from collections import Counter
from pathlib import Path
from random import Random
from typing import Sequence

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

_ROOT = project_root()
_DATA_DIR = _ROOT / "units" / "introduction-with-spam" / "bonus-webspam-detection-30-points" / "data"
_SUBMISSIONS = _ROOT / "submissions"
_SUBMISSIONS.mkdir(parents=True, exist_ok=True)

DEFAULT_SUBMISSION: Path = _SUBMISSIONS / "spam3_predictions.csv"

TRAIN_ZIP = _DATA_DIR / "webspam-train.zip"
TEST_ZIP = _DATA_DIR / "webspam-test.zip"
LABELS_FILE = _DATA_DIR / "webspam-train.labels"

# Pattern for HTML text extraction (removes tags)
HTML_TAG_RE = re.compile(r"<[^>]+>")
# Pattern for extracting words from HTML content
WORD_RE = re.compile(r"[a-z0-9$@._%+-]+")


def download(force: bool = False) -> None:
    """Download training and test data for spam3."""
    # Data is already present in the data directory
    pass


def load_training_items() -> list[ZipTextItem]:
    """Load training data from zip and labels file."""
    # Read labels
    labels_text = LABELS_FILE.read_text(encoding="utf-8")
    label_rows = parse_semicolon_labels(labels_text)
    label_by_path = dict(label_rows)

    # Load training zip file
    train_zip_path = TRAIN_ZIP
    if train_zip_path.exists():
        # Load from local zip
        members = list(label_by_path.keys())
        items = []
        for path, text in iter_zip_texts(train_zip_path, members):
            label = label_by_path[path]
            items.append(ZipTextItem(path=path, text=text, label=label))
        return items

    # Fallback: load from local directory
    data_dir = _DATA_DIR / "data"
    items = []
    for path, label in label_by_path.items():
        full_path = data_dir / path
        if full_path.exists():
            text = full_path.read_text(encoding="utf-8", errors="replace")
            items.append(ZipTextItem(path=path, text=text, label=label))
    return items


def load_test_items() -> list[ZipTextItem]:
    """Load test data from zip."""
    test_zip_path = TEST_ZIP
    if test_zip_path.exists():
        # Get members from zip
        members = zip_members(test_zip_path)
        # Filter for HTML-like files (no directory entries)
        members = [m for m in members if not m.endswith("/")]
        items = []
        for path, text in iter_zip_texts(test_zip_path, members):
            items.append(ZipTextItem(path=path, text=text, label=None))
        return items

    # Fallback: load from local directory
    data_dir = _DATA_DIR / "data" / "webspam-test"
    items = []
    if data_dir.exists():
        for full_path in data_dir.iterdir():
            if full_path.is_file():
                text = full_path.read_text(encoding="utf-8", errors="replace")
                path = "webspam-test/" + full_path.name
                items.append(ZipTextItem(path=path, text=text, label=None))
    return items


def extract_features(text: str) -> Counter[str]:
    """Extract robust text features for spam/ham classification from HTML.

    Handles HTML by stripping tags and extracting words and character patterns.
    """
    # Strip HTML tags
    text = HTML_TAG_RE.sub(" ", text)

    # Normalize whitespace
    text = re.sub(r"\s+", " ", text)

    lowered = text.lower()
    features: Counter[str] = Counter()

    # Word features
    words = WORD_RE.findall(lowered)
    features.update(f"w={token}" for token in words)

    # Character n-grams catch misspellings/obfuscation
    compact = re.sub(r"\s+", " ", lowered)
    for i in range(max(0, len(compact) - 2)):
        features[f"c3={compact[i:i+3]}"] += 1

    return features


class NaiveBayesTextModel:
    """Multinomial Naive Bayes classifier with clipping for robustness."""

    def __init__(
        self,
        alpha: float = 0.1,
        clip_count: int = 3,
    ):
        self.alpha = alpha
        self.clip_count = clip_count
        self.class_doc_counts: list[int] | None = None
        self.class_token_counts: list[int] | None = None
        self.feature_counts: list[Counter[str]] | None = None
        self.vocab: set[str] | None = None

    def fit(self, texts: Sequence[str], labels: Sequence[int]) -> "NaiveBayesTextModel":
        """Fit the model on labeled texts."""
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
        """Predict class (0=ham, 1=spam) for a single text."""
        self._check_fitted()
        assert self.class_doc_counts is not None
        assert self.class_token_counts is not None
        assert self.feature_counts is not None
        assert self.vocab is not None

        n_docs = sum(self.class_doc_counts)
        vocab_size = len(self.vocab)

        # Log priors with smoothing
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

    def predict(self, texts: Sequence[str]) -> list[int]:
        """Predict classes for multiple texts."""
        return [self.predict_one(text) for text in texts]


def stratified_holdout(
    items: Sequence[ZipTextItem], validation_fraction: float, seed: int
) -> tuple[list[ZipTextItem], list[ZipTextItem]]:
    """Create stratified train/validation split."""
    rng = Random(seed)
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
    """Train on a split and return balanced accuracy on holdout set."""
    items = load_training_items()
    train_items, val_items = stratified_holdout(items, validation_fraction, seed)

    model = NaiveBayesTextModel(alpha=0.1, clip_count=3).fit(
        [item.text for item in train_items],
        [int(item.label) for item in train_items],
    )

    y_true = [int(item.label) for item in val_items]
    y_pred = model.predict([item.text for item in val_items])
    bacc = balanced_accuracy(y_true, y_pred)

    # Confusion matrix
    tn = fp = fn = tp = 0
    for actual, pred in zip(y_true, y_pred):
        if actual == 0 and pred == 0:
            tn += 1
        elif actual == 0 and pred == 1:
            fp += 1
        elif actual == 1 and pred == 0:
            fn += 1
        else:
            tp += 1

    print(f"[spam3] validation examples: {len(val_items)}")
    print(
        f"[spam3] confusion: tn={tn} fp={fp} fn={fn} tp={tp}"
    )
    print(f"[spam3] balanced_accuracy={bacc:.6f}")
    return bacc


def solve(output_path: Path = DEFAULT_SUBMISSION) -> Path:
    """Train on full training set and write predictions."""
    train_items = load_training_items()
    test_items = load_test_items()

    model = NaiveBayesTextModel(alpha=0.1, clip_count=3).fit(
        [item.text for item in train_items],
        [int(item.label) for item in train_items],
    )

    predictions = model.predict([item.text for item in test_items])
    rows = [(item.path, pred) for item, pred in zip(test_items, predictions)]
    write_semicolon_predictions(rows, output_path)

    n_spam = sum(predictions)
    print(f"[spam3] wrote {len(rows)} predictions to {output_path}")
    print(f"[spam3] predicted ham={len(rows) - n_spam} spam={n_spam}")
    return output_path