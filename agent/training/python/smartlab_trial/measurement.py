"""Controller metadata only; agent code interprets opaque sample inputs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd

from .invocation import InvocationError


def validate_config(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvocationError("measurement must be a controller-supplied object")
    allowed = {"kind", "sampleManifestPath", "sampleManifestSha256", "hasTargets", "execution", "scoreMethod", "scoreDirection", "anomalyLabel", "evidence", "evidenceManifestSha256"}
    if set(value) - allowed:
        raise InvocationError("measurement contains unknown fields")
    if value.get("kind") not in ("clustering", "anomaly_detection"):
        raise InvocationError("measurement.kind must be clustering or anomaly_detection")
    if not isinstance(value.get("sampleManifestPath"), str) or not value["sampleManifestPath"]:
        raise InvocationError("measurement.sampleManifestPath must name development metadata")
    if value.get("execution") not in ("inductive", "batch"):
        raise InvocationError("measurement.execution must be inductive or batch")
    if value["kind"] == "anomaly_detection":
        if value.get("scoreMethod") not in ("score_samples", "decision_function", "negative_outlier_factor_"):
            raise InvocationError("anomaly measurement requires score_samples, decision_function, or batch negative_outlier_factor_")
        if value["scoreMethod"] == "negative_outlier_factor_" and value["execution"] != "batch":
            raise InvocationError("negative_outlier_factor_ describes fitted rows and requires batch execution")
        if value.get("scoreDirection") not in ("higher_is_anomalous", "lower_is_anomalous"):
            raise InvocationError("anomaly measurement requires an explicit scoreDirection")
        if type(value.get("anomalyLabel")) is not int:
            raise InvocationError("anomaly measurement requires an integer anomalyLabel")
        if "evidence" in value:
            evidence = value["evidence"]
            if (not isinstance(evidence, dict) or set(evidence) != {"path", "source"}
                    or not isinstance(evidence["path"], str) or not evidence["path"]
                    or evidence["source"] not in ("trusted", "agent_provided")):
                raise InvocationError("Evidence requires a path and explicit trusted/agent_provided source")
    elif any(key in value for key in ("scoreMethod", "scoreDirection", "anomalyLabel", "evidence", "evidenceManifestSha256")):
        raise InvocationError("anomaly score fields do not apply to clustering")
    return dict(value)


def load_samples(config: dict[str, Any]) -> tuple[Any, list[str] | None, str]:
    path = Path(config["sampleManifestPath"])
    with path.open("rb") as stream:
        content = stream.read(64 * 1024 * 1024 + 1)
    if len(content) > 64 * 1024 * 1024:
        raise InvocationError("Sample metadata exceeds 64 MiB; keep sample contents in agent-readable files")
    digest = hashlib.sha256(content).hexdigest()
    if config.get("sampleManifestSha256") is not None and config["sampleManifestSha256"] != digest:
        raise InvocationError("Sample manifest changed since preflight")
    document = json.loads(content)
    if not isinstance(document, dict) or document.get("schemaVersion") != 1 or set(document) != {"schemaVersion", "samples"}:
        raise InvocationError("Sample metadata requires schemaVersion=1 and samples")
    samples = document["samples"]
    if not isinstance(samples, list) or len(samples) < 2:
        raise InvocationError("Sample metadata requires at least two development samples")
    ids, labelled = set(), []
    for sample in samples:
        if not isinstance(sample, dict) or set(sample) - {"id", "input", "target"} or "input" not in sample:
            raise InvocationError("Each sample requires id and opaque input, with optional target")
        row_id = sample.get("id")
        if not isinstance(row_id, str) or not row_id or row_id in ids:
            raise InvocationError("Sample IDs must be unique non-empty strings")
        ids.add(row_id)
        labelled.append("target" in sample)
        if "target" in sample and (type(sample["target"]) not in (str, int) or sample["target"] == ""):
            raise InvocationError("Family targets must be non-empty strings or integer identifiers")
    if any(labelled) and not all(labelled):
        raise InvocationError("Family targets must cover every development sample or be absent")
    if "hasTargets" in config and config["hasTargets"] is not all(labelled):
        raise InvocationError("Sample targets differ from the controller's preflight declaration")
    if all(labelled) and len({type(sample["target"]) for sample in samples}) != 1:
        raise InvocationError("Family target identifiers must have a uniform type")
    if config["kind"] == "anomaly_detection" and any(labelled):
        raise InvocationError("Label-free anomaly metadata must omit targets; evidence-label scoring is a later adapter")
    samples = sorted(samples, key=lambda sample: sample["id"])
    targets = [str(sample["target"]) for sample in samples] if all(labelled) else None
    frame = pd.DataFrame([{"id": sample["id"], "input": sample["input"]} for sample in samples])
    if "evidence" in config:
        frame.attrs["diagnosticEvidence"] = load_evidence(config, ids)
    return frame, targets, digest


def load_evidence(config: dict[str, Any], ids: set[str]) -> dict[str, Any]:
    with Path(config["evidence"]["path"]).open("rb") as stream:
        content = stream.read(8 * 1024 * 1024 + 1)
    if len(content) > 8 * 1024 * 1024:
        raise InvocationError("Evidence metadata exceeds 8 MiB")
    digest = hashlib.sha256(content).hexdigest()
    if config.get("evidenceManifestSha256") not in (None, digest):
        raise InvocationError("Evidence manifest changed since preflight")
    document = json.loads(content)
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "labels"} or document["schemaVersion"] != 1:
        raise InvocationError("Evidence metadata requires schemaVersion=1 and labels")
    rows = document["labels"]
    if not isinstance(rows, list) or not rows:
        raise InvocationError("Evidence labels must be a nonempty list")
    labels = {}
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {"id", "target"} or not isinstance(row["id"], str)
                or row["id"] not in ids or row["id"] in labels or type(row["target"]) is not int
                or row["target"] not in (0, 1)):
            raise InvocationError("Evidence requires unique known development IDs and binary integer targets (1 is anomalous)")
        labels[row["id"]] = row["target"]
    return {"labels": labels, "source": config["evidence"]["source"], "sha256": digest}


def kind(invocation: Any) -> str:
    return invocation.measurement["kind"] if invocation.measurement else "classification"


def primary_score(metrics: dict[str, Any]) -> float:
    for name in ("balancedAccuracy", "adjustedRandIndex"):
        if name in metrics:
            return float(metrics[name])
    raise InvocationError("No trusted primary metric available; label-free diagnostics cannot authorize search selection or promotion")
