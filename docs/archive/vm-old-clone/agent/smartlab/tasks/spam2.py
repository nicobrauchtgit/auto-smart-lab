"""Spam task 2 solver.

Uses the same Multinomial Naive Bayes approach as spam1 with word tokens
and character 3-grams. The data is larger (18757 training files vs 16662
for spam1) but the same approach should work well.

Key improvements over spam1:
1. More aggressive feature extraction for HTML/spam patterns
2. Header presence features (spam often lacks proper headers)
3. Special spam phrase detection
4. Character-level n-grams for obfuscated words
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

TRAIN_URL = "https://download.smartlab.mlsec.tu-berlin.de/introduction-with-spam/spam-detection-in-practice-50-points/spam2-train.zip"
TEST_URL = "https://download.smartlab.mlsec.tu-berlin.de/introduction-with-spam/spam-detection-in-practice-50-points/spam2-test.zip"
_UNITS_DATA = project_root() / "units" / "introduction-with-spam" / "spam-detection-in-practice-50-points" / "data"
_LEGACY_DATA = project_root() / "agent" / "data" / "raw"
TRAIN_ZIP = _UNITS_DATA / "spam2-train.zip" if (_UNITS_DATA / "spam2-train.zip").exists() else _LEGACY_DATA / "spam2-train.zip"
TEST_ZIP = _UNITS_DATA / "spam2-test.zip" if (_UNITS_DATA / "spam2-test.zip").exists() else _LEGACY_DATA / "spam2-test.zip"
DEFAULT_SUBMISSION = project_root() / "submissions" / "spam2_predictions.csv"
LABELS_MEMBER = "spam2-train.labels"
TEST_PREFIX = "data/spam2-test/"
WORD_RE = re.compile(r"[a-z0-9$@._%+-]+")

# Patterns to extract from email headers
HEADER_PATTERNS = {
    "subject": re.compile(r"^Subject:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
    "from": re.compile(r"^From:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
    "to": re.compile(r"^To:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
    "x_spam_status": re.compile(r"^X-Spam-Status:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
}

# HTML tags - spam emails have more HTML
HTML_TAGS = {"<html>", "</html>", "<body>", "</body>", "<div>", "</div>", "<p>", "</p>",
             "<table>", "</table>", "<tr>", "</tr>", "<td>", "</td>", "<font>", "</font>",
             "<a ", "<a>", "</a>", "<img", "<br", "<br/>", "<span", "<style",
             "<script", "</script>", "<head>", "</head>", "<title>", "</title>"}

# Common spam phrases
SPAM_PHRASES = [
    "free money", "click here", "buy now", "limited time", "act now",
    "congratulations", "winner", "prize", "winning", "lottery",
    "urgent", "important", "confidential", "confidentially",
    "inheritance", "million dollars", "billions", "rich",
    "viagra", "cialis", "levitra", "pharmacy", "medication",
    "prescription", "no prescription", "doctor approved",
    "risk free", "guarantee", "guaranteed",
    "make money", "earn money", "work from home", "income",
    "unsubscribe", "opt out", "opt-out",
]


def extract_headers(text: str) -> dict[str, str]:
    """Extract key headers from email text."""
    headers = {}
    for name, pattern in HEADER_PATTERNS.items():
        match = pattern.search(text)
        if match:
            headers[name] = match.group(1).strip()
    return headers


def has_header(text: str, header_name: str) -> bool:
    """Check if email has a specific header."""
    if header_name == "subject":
        return bool(re.search(r"^Subject:\s*.+", text, re.MULTILINE | re.IGNORECASE))
    elif header_name == "from":
        return bool(re.search(r"^From:\s*.+", text, re.MULTILINE | re.IGNORECASE))
    elif header_name == "to":
        return bool(re.search(r"^To:\s*.+", text, re.MULTILINE | re.IGNORECASE))
    elif header_name == "x_spam_status":
        return bool(re.search(r"^X-Spam-Status:\s*.+", text, re.MULTILINE | re.IGNORECASE))
    return False


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
    # Use the full email including headers
    lowered = text.lower()
    features: Counter[str] = Counter()

    words = WORD_RE.findall(lowered)
    features.update(f"w={token}" for token in words)

    # Character n-grams catch misspellings/obfuscation like "v1agra" or
    # punctuation-heavy spam while still being cheap enough for this dataset.
    compact = re.sub(r"\s+", " ", lowered)
    features.update(f"c3={compact[i:i+3]}" for i in range(max(0, len(compact) - 2)))
    
    # Also add Subject line as a special prefix to give it more weight
    headers = extract_headers(text)
    if "subject" in headers:
        subject = headers["subject"].lower()
        subject_words = WORD_RE.findall(subject)
        features.update(f"sw={token}" for token in subject_words)

    # Header presence features - spam often lacks proper headers
    if not has_header(text, "subject"):
        features["no_subject"] += 1
    if not has_header(text, "from"):
        features["no_from"] += 1
    if not has_header(text, "to"):
        features["no_to"] += 1
    if not has_header(text, "x_spam_status"):
        features["no_x_spam_status"] += 1
    else:
        features["has_x_spam_status"] += 1
    
    # HTML tag count - spam emails have more HTML
    html_count = sum(1 for tag in HTML_TAGS if tag in lowered)
    features[f"html_count={min(html_count, 10)}"] += 1
    
    # HTML tag density
    html_density = sum(1 for c in text if c in "<>")
    features[f"html_bracket={min(html_density, 20)}"] += 1
    
    # Common spam phrase detection
    for phrase in SPAM_PHRASES:
        if phrase in lowered:
            features[f"spam_phrase={phrase.replace(' ', '_')}"] += 1
    
    # URLs - spam often has more
    url_count = len(re.findall(r"http://|https://|www\.", lowered))
    features[f"url_count={min(url_count, 5)}"] += 1
    
    # Email addresses
    email_count = len(re.findall(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", lowered))
    features[f"email_count={min(email_count, 5)}"] += 1
    
    # Long random strings (common in spam for obfuscation)
    long_random = len(re.findall(r"[a-z0-9]{20,}", lowered))
    features[f"long_random={min(long_random, 5)}"] += 1
    
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
    
    # Simple parameter search - test key combinations
    param_configs = [
        {"alpha": 0.01, "clip_count": 1},
        {"alpha": 0.1, "clip_count": 2},
        {"alpha": 0.1, "clip_count": 3},
        {"alpha": 1.0, "clip_count": 3},
        {"alpha": 5.0, "clip_count": 2},
    ]
    
    best_params = {"alpha": 0.1, "clip_count": 3}
    best_score = 0.0
    
    for params in param_configs:
        model = NaiveBayesTextModel(alpha=params['alpha'], clip_count=params['clip_count']).fit(
            [item.text for item in train_items], [int(item.label) for item in train_items]
        )
        y_true = [int(item.label) for item in val_items]
        y_pred = model.predict([item.text for item in val_items])
        bacc = balanced_accuracy(y_true, y_pred)
        
        print(f"[spam2] alpha={params['alpha']}, clip={params['clip_count']}: bacc={bacc:.6f}")
        
        if bacc > best_score:
            best_score = bacc
            best_params = dict(params)
    
    model = NaiveBayesTextModel(alpha=best_params['alpha'], clip_count=best_params['clip_count']).fit(
        [item.text for item in train_items], [int(item.label) for item in train_items]
    )
    y_true = [int(item.label) for item in val_items]
    y_pred = model.predict([item.text for item in val_items])
    bacc = balanced_accuracy(y_true, y_pred)

    confusion = {(actual, pred): 0 for actual in (0, 1) for pred in (0, 1)}
    for actual, pred in zip(y_true, y_pred):
        confusion[(actual, pred)] += 1
    print(f"[spam2] validation examples: {len(val_items)}")
    print(
        "[spam2] confusion: "
        f"tn={confusion[(0, 0)]} fp={confusion[(0, 1)]} "
        f"fn={confusion[(1, 0)]} tp={confusion[(1, 1)]}"
    )
    print(f"[spam2] balanced_accuracy={bacc:.6f}")
    print(f"[spam2] best_params: alpha={best_params['alpha']}, clip_count={best_params['clip_count']}")
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
    print(f"[spam2] wrote {len(rows)} predictions: {output_path}")
    print(f"[spam2] predicted ham={len(rows) - n_spam} spam={n_spam}")
    return output_path
