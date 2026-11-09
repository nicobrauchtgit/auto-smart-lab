"""Harness data profile: deterministic, full-corpus facts about the declared task data.

The research agent receives this profile instead of rewriting the same survey for
every task. Records are generic (inventory, sizes, content types, duplicates,
target counts, member-name and order leakage, training vs test) plus a text
layer that applies when most samples decode as text. Domain analysis stays with
the agent.

Each record has ``split``, ``scope``, ``population``, ``method`` and ``values`` so
it can be cited like an agent artifact. Only compact aggregates are stored:
never sample contents, member names, or a name-to-target map.

Usage: data_profile.py --spec '<json>' --out <profile.json>
Spec keys: trainZip, testZip, targetsPath (or null), targets ("binary" |
"families" | "none"), source ("zip_members" | "pcap_tcp_connections"),
datasetSnapshotSha256, and optionally textMinFraction (from harness.config.json
research.profileTextMinPercent).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "training" / "python"))
from task_samples import TaskDataError, archive_ids, read_targets, sample_descriptors  # noqa: E402

SCHEMA_VERSION = 1
GENERATOR = "agent/research/python/data_profile.py"
TEXT_LAYER_MIN_FRACTION = 0.9
HEAD_BYTES = 4096

MAGIC = [
    (b"%PDF", "pdf"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole"),
    (b"PK\x03\x04", "zip"),
    (b"MZ", "pe"),
    (b"\x7fELF", "elf"),
    (b"\x1f\x8b", "gzip"),
    (b"{\\rtf", "rtf"),
    (b"\x89PNG", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF8", "gif"),
]
EMAIL_HEADER = re.compile(rb"^(?:from|received|subject|return-path|message-id|date|to):", re.IGNORECASE | re.MULTILINE)
HTML_MARKER = re.compile(rb"<\s*(?:html|body|!doctype\s+html|head|div|table|a\s+href)\b", re.IGNORECASE)
URL = re.compile(rb"https?://", re.IGNORECASE)


def quantiles(values: list[float]) -> dict:
    if not values:
        return {"count": 0}
    ordered = sorted(values)
    pick = lambda q: ordered[min(len(ordered) - 1, int(q * (len(ordered) - 1) + 0.5))]  # noqa: E731
    return {"count": len(ordered), "min": ordered[0], "p05": pick(0.05), "p25": pick(0.25), "median": pick(0.5),
            "p75": pick(0.75), "p95": pick(0.95), "max": ordered[-1], "mean": round(sum(ordered) / len(ordered), 2)}


def content_type(content: bytes) -> tuple[str, bool]:
    """(category, decodes as UTF-8 text) from magic bytes and a bounded decode check."""
    for magic, name in MAGIC:
        if content.startswith(magic):
            return name, False
    head = content[:HEAD_BYTES]
    try:
        head.decode("utf-8")
        utf8 = True
    except UnicodeDecodeError as error:
        # A multibyte character cut at the boundary still counts as UTF-8.
        utf8 = error.start >= len(head) - 3
    control = sum(1 for byte in head if byte < 9 or 13 < byte < 32)
    if b"\x00" in head or control > len(head) * 0.05:
        return "binary", False
    if EMAIL_HEADER.search(head[:2048]):
        return "email", utf8
    if HTML_MARKER.search(head):
        return "html", utf8
    return "text", utf8


def text_measures(content: bytes) -> dict:
    return {"bytes": len(content), "lines": content.count(b"\n") + (0 if content.endswith(b"\n") or not content else 1),
            "urls": len(URL.findall(content)), "html": bool(HTML_MARKER.search(content)),
            "email_headers": bool(EMAIL_HEADER.search(content[:2048]))}


def scan_archive(path: str, members: list[str]) -> dict:
    """One pass over the archive: per-member size, type, content hash, text measures; archive order."""
    rows = {}
    with zipfile.ZipFile(path) as archive:
        order = {entry.filename: index for index, entry in enumerate(archive.infolist())}
        for name in members:
            content = archive.read(name)
            category, utf8 = content_type(content)
            rows[name] = {"category": category, "utf8": utf8, "sha256": hashlib.sha256(content).hexdigest(),
                          "order": order[name], **text_measures(content)}
    return rows


def record(split: str | None, population: int, method: str, values: dict) -> dict:
    return {**({"split": split} if split else {}), "scope": "full", "population": population, "method": method, "values": values}


def suffix(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1] if "." in base else ""


def directory(name: str) -> str:
    return name.rsplit("/", 1)[0] if "/" in name else ""


def purity(keys: list[str], targets: list) -> dict:
    """How well a name-derived key alone predicts the target (majority target per key)."""
    groups: dict[str, Counter] = defaultdict(Counter)
    for key, target in zip(keys, targets):
        groups[key][str(target)] += 1
    correct = sum(counter.most_common(1)[0][1] for counter in groups.values())
    baseline = Counter(str(target) for target in targets).most_common(1)[0][1]
    return {"distinct_values": len(groups), "majority_accuracy": round(correct / len(targets), 4),
            "majority_class_accuracy": round(baseline / len(targets), 4),
            "key_equals_target_fraction": round(sum(1 for key, target in zip(keys, targets) if key == str(target)) / len(targets), 4)}


def zip_profile(spec: dict) -> dict:
    train_ids = archive_ids(spec["trainZip"], spec.get("targetsPath"))
    test_ids = archive_ids(spec["testZip"])
    targets_kind = spec.get("targets", "none")
    targets = read_targets(spec["targetsPath"], targets_kind) if targets_kind != "none" and spec.get("targetsPath") else None
    train = scan_archive(spec["trainZip"], train_ids)
    test = scan_archive(spec["testZip"], test_ids)
    evidence: dict[str, dict] = {}
    for split, rows in (("training", train), ("test", test)):
        n = len(rows)
        sizes = [row["bytes"] for row in rows.values()]
        evidence[f"{split}.inventory"] = record(split, n, "Archive member count and uncompressed bytes", {
            "samples": n, "total_bytes": sum(sizes)})
        evidence[f"{split}.sizes"] = record(split, n, "Uncompressed member size in bytes, nearest-rank quantiles", quantiles(sizes))
        categories = Counter(row["category"] for row in rows.values())
        evidence[f"{split}.content_types"] = record(split, n, "Magic-byte category, else text/html/email heuristics on the first 4 KiB", {
            "categories": dict(sorted(categories.items())),
            "utf8_fraction": round(sum(row["utf8"] for row in rows.values()) / n, 4)})
        by_hash = Counter(row["sha256"] for row in rows.values())
        groups = [count for count in by_hash.values() if count > 1]
        evidence[f"{split}.duplicates"] = record(split, n, "Exact duplicate contents by SHA-256 within the split", {
            "duplicate_groups": len(groups), "samples_in_duplicate_groups": sum(groups), "distinct_contents": len(by_hash)})
    train_hashes = {row["sha256"] for row in train.values()}
    overlap = [name for name, row in test.items() if row["sha256"] in train_hashes]
    evidence["training_vs_test.exact_overlap"] = record(None, len(test), "Test members whose exact content (SHA-256) also occurs in training", {
        "test_samples_matching_training": len(overlap), "fraction_of_test": round(len(overlap) / len(test), 4)})
    evidence["training_vs_test.name_suffixes"] = record(None, len(train) + len(test), "Distinct member-name suffixes after the last dot, per split", {
        "training": dict(Counter(suffix(name) for name in train_ids).most_common(5)),
        "test": dict(Counter(suffix(name) for name in test_ids).most_common(5))})

    if targets is not None:
        ordered = [targets[name] for name in train_ids]
        if targets_kind == "binary":
            counts = Counter(str(value) for value in ordered)
            evidence["training.targets"] = record("training", len(ordered), "Target counts from the declared targets file", {
                "counts": dict(sorted(counts.items())), "fractions": {k: round(v / len(ordered), 4) for k, v in sorted(counts.items())}})
            per_target = defaultdict(list)
            for name in train_ids:
                per_target[str(targets[name])].append(train[name]["bytes"])
            evidence["training.sizes_by_target"] = record("training", len(ordered), "Uncompressed member size in bytes per target, nearest-rank quantiles", {
                target: quantiles(values) for target, values in sorted(per_target.items())})
        else:
            sizes = Counter(str(value) for value in ordered).values()
            evidence["training.targets"] = record("training", len(ordered), "Family sizes from the declared targets file", {
                "families": len(sizes), "largest": max(sizes), "smallest": min(sizes), "singletons": sum(1 for size in sizes if size == 1),
                "sizes": quantiles(list(sizes))})
        conflicts = defaultdict(set)
        for name in train_ids:
            conflicts[train[name]["sha256"]].add(str(targets[name]))
        evidence["training.duplicate_target_conflicts"] = record("training", len(ordered), "Exact-duplicate content groups whose members carry different targets", {
            "conflicting_groups": sum(1 for values in conflicts.values() if len(values) > 1)})
        evidence["training.name_leakage"] = record("training", len(ordered), "Predicting the target from member-name parts alone (majority target per value)", {
            "suffix": purity([suffix(name) for name in train_ids], ordered),
            "directory": purity([directory(name) for name in train_ids], ordered),
            "test_suffixes_distinct": len({suffix(name) for name in test_ids})})
        by_order = sorted(train_ids, key=lambda name: train[name]["order"])
        quarter = max(1, len(by_order) // 4)
        quarters = [by_order[i * quarter:(i + 1) * quarter if i < 3 else len(by_order)] for i in range(4)]
        evidence["training.order_leakage"] = record("training", len(ordered), "Target distribution per quarter of archive member order", {
            f"q{i + 1}": dict(sorted(Counter(str(targets[name]) for name in part).items())) for i, part in enumerate(quarters) if part})

    text_fraction = min(sum(row["category"] in ("text", "html", "email") for row in rows.values()) / len(rows) for rows in (train, test))
    layers = ["generic"]
    if text_fraction >= float(spec.get("textMinFraction", TEXT_LAYER_MIN_FRACTION)):
        layers.append("text")
        for split, rows in (("training", train), ("test", test)):
            n = len(rows)
            evidence[f"{split}.text"] = record(split, n, "Per-member line count, http(s) URL count, HTML-marker and email-header presence rates", {
                "lines": quantiles([row["lines"] for row in rows.values()]),
                "urls": quantiles([row["urls"] for row in rows.values()]),
                "html_rate": round(sum(row["html"] for row in rows.values()) / n, 4),
                "email_header_rate": round(sum(row["email_headers"] for row in rows.values()) / n, 4)})
        if targets is not None and targets_kind == "binary":
            per_target = defaultdict(list)
            for name in train_ids:
                per_target[str(targets[name])].append(train[name])
            evidence["training.text_by_target"] = record("training", len(train), "Text measures per target", {
                target: {"lines_median": quantiles([row["lines"] for row in rows])["median"],
                         "urls_median": quantiles([row["urls"] for row in rows])["median"],
                         "html_rate": round(sum(row["html"] for row in rows) / len(rows), 4),
                         "email_header_rate": round(sum(row["email_headers"] for row in rows) / len(rows), 4)}
                for target, rows in sorted(per_target.items())})
    return {"layers": layers, "evidence": evidence}


def pcap_profile(spec: dict) -> dict:
    evidence = {}
    for split, key in (("training", "trainZip"), ("test", "testZip")):
        samples = sample_descriptors(spec[key], "pcap_tcp_connections")
        evidence[f"{split}.inventory"] = record(split, max(1, len(samples)), "TCP connection samples identified by the harness sample adapter", {
            "samples": len(samples), "capture_bytes": Path(spec[key]).stat().st_size})
    return {"layers": ["generic"], "evidence": evidence}


def profile(spec: dict) -> dict:
    source = spec.get("source", "zip_members")
    body = pcap_profile(spec) if source == "pcap_tcp_connections" else zip_profile(spec)
    return {"schema_version": SCHEMA_VERSION, "generator": GENERATOR, "source": source,
            "dataset_snapshot_sha256": spec["datasetSnapshotSha256"], **body}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        result = profile(json.loads(args.spec))
    except (TaskDataError, OSError, zipfile.BadZipFile, KeyError, ValueError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 1
    Path(args.out).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"records": len(result["evidence"]), "layers": result["layers"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
