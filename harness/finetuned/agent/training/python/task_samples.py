"""Sample identity for declared task data: archive members or TCP connections.

ZIP inputs use directories/targets only; PCAP inputs parse connection headers.
Agent code interprets sample inputs (D9); this script only establishes which
samples exist and which targets the controller may use.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path


class TaskDataError(ValueError):
    pass


def archive_ids(path: str, sidecar: str | None = None) -> list[str]:
    """Sorted file members. An embedded copy of the targets file is excluded only if byte-identical."""
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise TaskDataError(f"Corrupt archive: {Path(path).name}")
        values = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        if len(set(values)) != len(values):
            raise TaskDataError(f"Duplicate member names in {Path(path).name}")
        if sidecar is not None and Path(sidecar).name in values:
            if archive.read(Path(sidecar).name) != Path(sidecar).read_bytes():
                raise TaskDataError("Embedded targets file differs from the declared targets file")
            values.remove(Path(sidecar).name)
    if not values:
        raise TaskDataError(f"Archive has no samples: {Path(path).name}")
    return sorted(values)


def read_targets(path: str, kind: str) -> dict[str, int | str]:
    targets: dict[str, int | str] = {}
    text = Path(path).read_bytes().decode("utf-8").lstrip("﻿")
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        separator = line.rfind(";")
        row_id, value = line[:separator].strip(), line[separator + 1:].strip()
        if separator < 1 or not row_id or not value:
            raise TaskDataError(f"Invalid id;target record at line {number}")
        if row_id in targets:
            raise TaskDataError(f"Repeated sample ID at line {number}")
        if kind == "binary":
            if value not in ("0", "1"):
                raise TaskDataError(f"Binary targets must be 0 or 1 (line {number})")
            targets[row_id] = int(value)
        else:
            targets[row_id] = value
    if not targets:
        raise TaskDataError("The targets file has no records")
    return targets


def sample_descriptors(path: str, source: str = "zip_members", sidecar: str | None = None) -> list[dict]:
    if source == "pcap_tcp_connections":
        from pcap_samples import connection_samples
        return connection_samples(path)
    if source != "zip_members":
        raise TaskDataError("Unsupported sample source")
    return [{"id": row_id, "input": {"archive": path, "member": row_id}}
            for row_id in archive_ids(path, sidecar)]


def rows(spec: dict) -> dict:
    samples = sample_descriptors(spec["zip"], spec.get("source", "zip_members"), spec.get("targetsPath"))
    ids = [sample["id"] for sample in samples]
    if spec.get("targets", "none") == "none" or not spec.get("targetsPath"):
        return {"ids": ids, "targets": None, **({"samples": samples} if spec.get("includeSamples") else {})}
    targets = read_targets(spec["targetsPath"], spec["targets"])
    if set(targets) != set(ids):
        missing, extra = len(set(ids) - set(targets)), len(set(targets) - set(ids))
        raise TaskDataError(f"Targets must cover exactly the training samples ({missing} without target, {extra} unknown)")
    return {"ids": ids, "targets": [targets[row_id] for row_id in ids], **({"samples": samples} if spec.get("includeSamples") else {})}


def inspect(spec: dict) -> dict:
    train = rows({"zip": spec["trainZip"], "targetsPath": spec.get("targetsPath"), "targets": spec["targets"], "source": spec.get("source", "zip_members")})
    test = [sample["id"] for sample in sample_descriptors(spec["testZip"], spec.get("source", "zip_members"))]
    if set(train["ids"]) & set(test):
        raise TaskDataError("Training and test archives share sample IDs")
    if spec.get("neutralTestIds") and not all(name.endswith(".x") for name in test):
        raise TaskDataError("Binary classification test IDs must use the neutral .x suffix")
    summary: dict = {"kind": spec["targets"]}
    if train["targets"] is not None and spec["targets"] == "binary":
        counts = Counter(str(value) for value in train["targets"])
        if set(counts) != {"0", "1"}:
            raise TaskDataError("Binary targets need both classes")
        summary["counts"] = dict(sorted(counts.items()))
    elif train["targets"] is not None:
        sizes = Counter(train["targets"]).values()
        if len(sizes) < 3:
            raise TaskDataError("Family targets need at least three families for group-held-out validation")
        summary.update(families=len(sizes), largest=max(sizes), smallest=min(sizes),
                       singletons=sum(1 for size in sizes if size == 1))
    return {"trainRows": len(train["ids"]), "testRows": len(test), "targets": summary}


if __name__ == "__main__":
    sys.modules["task_samples"] = sys.modules[__name__]
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect")
    mode.add_argument("--rows")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(json.loads(args.inspect)) if args.inspect else rows(json.loads(args.rows))))
    except (TaskDataError, OSError, zipfile.BadZipFile, UnicodeDecodeError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
