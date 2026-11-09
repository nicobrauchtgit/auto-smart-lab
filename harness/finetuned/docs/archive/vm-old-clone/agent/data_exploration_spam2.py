#!/usr/bin/env python3
"""Data exploration script for spam2."""

from pathlib import Path
import re
from collections import Counter

# Paths
UNITS_DATA = Path("units") / "introduction-with-spam" / "spam-detection-in-practice-50-points" / "data"
TRAIN_ZIP = UNITS_DATA / "spam2-train.zip"
TEST_ZIP = UNITS_DATA / "spam2-test.zip"
LABELS_MEMBER = "spam2-train.labels"

# Import helpers from common module
import sys
sys.path.insert(0, "smartlab")
from smartlab.common import (
    read_zip_text,
    iter_zip_texts,
    parse_semicolon_labels,
    zip_members,
)

WORD_RE = re.compile(r"[a-z0-9$@._%+-]+")

def main():
    # Load training data
    print("=== Loading training data ===")
    labels = parse_semicolon_labels(read_zip_text(TRAIN_ZIP, LABELS_MEMBER))
    label_by_path = dict(labels)
    train_items = list(iter_zip_texts(TRAIN_ZIP, list(label_by_path)))
    print(f"Training items: {len(train_items)}")

    # Class balance
    spam_count = sum(1 for p, _ in train_items if label_by_path[p] == 1)
    ham_count = sum(1 for p, _ in train_items if label_by_path[p] == 0)
    print(f"Ham: {ham_count}, Spam: {spam_count}")

    # Load test data
    print("\n=== Loading test data ===")
    test_members = [m for m in zip_members(TEST_ZIP, prefix="data/spam2-test/") if m.endswith(".x")]
    test_items = list(iter_zip_texts(TEST_ZIP, test_members))
    print(f"Test items: {len(test_items)}")

    # Explore training samples
    print("\n=== Sample email (ham) ===")
    ham_sample = next((p, t) for p, t in train_items if label_by_path[p] == 0)
    print(f"Path: {ham_sample[0]}")
    print("First 1000 chars:")
    print(ham_sample[1][:1000])

    print("\n=== Sample email (spam) ===")
    spam_sample = next((p, t) for p, t in train_items if label_by_path[p] == 1)
    print(f"Path: {spam_sample[0]}")
    print("First 1000 chars:")
    print(spam_sample[1][:1000])

    # Feature analysis
    print("\n=== Feature analysis ===")
    ham_features = Counter()
    spam_features = Counter()

    for path, text in train_items:
        labels = WORD_RE.findall(text.lower())
        if label_by_path[path] == 0:
            ham_features.update(labels)
        else:
            spam_features.update(labels)

    print("\nTop 20 ham features:")
    for feature, count in ham_features.most_common(20):
        print(f"  {feature}: {count}")

    print("\nTop 20 spam features:")
    for feature, count in spam_features.most_common(20):
        print(f"  {feature}: {count}")

    # Find distinctive features (spam vs ham)
    print("\n=== Distinctive features (spam/ham ratio) ===")
    all_features = set(ham_features) | set(spam_features)
    ratios = []
    for f in all_features:
        h = ham_features[f]
        s = spam_features[f]
        if h > 0 and s > 0:
            ratio = s / h if h > 0 else float('inf')
            ratios.append((f, s, h, ratio))
        elif s > 0:
            ratios.append((f, s, 0, float('inf')))
        elif h > 0:
            ratios.append((f, 0, h, 0.0))

    ratios.sort(key=lambda x: -x[3])
    print("Most spam-dominant features:")
    for f, s, h, r in ratios[:20]:
        print(f"  {f}: spam={s}, ham={h}, ratio={r:.2f}")

    ratios.sort(key=lambda x: x[3])
    print("\nMost ham-dominant features:")
    for f, s, h, r in ratios[:20]:
        print(f"  {f}: spam={s}, ham={h}, ratio={r:.2f}")

    # Header analysis
    print("\n=== Header patterns ===")
    header_pats = {
        "subject": re.compile(r"^Subject:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
        "from": re.compile(r"^From:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
        "to": re.compile(r"^To:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
        "x_spam_status": re.compile(r"^X-Spam-Status:\s*(.+)$", re.MULTILINE | re.IGNORECASE),
    }

    for path, text in train_items[:5]:
        print(f"\n--- {path} ---")
        for name, pat in header_pats.items():
            m = pat.search(text)
            if m:
                print(f"  {name}: {m.group(1).strip()}")

    # Length stats
    print("\n=== Document length stats ===")
    lengths = [(len(text.split()), len(text)) for _, text in train_items]
    avg_words = sum(l[0] for l in lengths) / len(lengths)
    avg_chars = sum(l[1] for l in lengths) / len(lengths)
    print(f"Avg words: {avg_words:.1f}, Avg chars: {avg_chars:.1f}")

if __name__ == "__main__":
    main()