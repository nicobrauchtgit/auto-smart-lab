"""Rerun the frozen champion on a challenger's exact fold manifest.

The champion's commit is checked out as its own worktree, and the rerun happens
in a separate interpreter: champion and challenger usually share module names
such as ``solutions.features``, and loading both into one process would hand
the second import Python's cached copy of the first. The persisted manifest,
not a second call to any splitter, defines the folds, so the comparison is
paired fold by fold and row by row.
"""
from __future__ import annotations

import dataclasses
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

from .artifacts import EventWriter, _atomic_json, _write_oof, append_fold_result
from .folds import ConcreteFold
from .invocation import Invocation, InvocationError, PipelineSpec, parse_invocation
from .search import _paired, fold_scores

SPEC_FILE = "champion-invocation.json"
FOLDS_FILE = "champion-fold-results.jsonl"
OOF_FILE = "champion_oof_predictions.csv"
RESULT_FILE = "champion-rerun.json"


def manifest_folds(manifest: dict[str, Any], ids: Sequence[str]) -> list[ConcreteFold]:
    """Rebuild folds from the manifest and prove the rows are the same rows."""
    if manifest.get("rowCount") != len(ids):
        raise InvocationError("champion rerun prepared a different number of rows than the manifest")
    for row in manifest.get("assignments", []):
        if ids[row["index"]] != row["id"]:
            raise InvocationError("champion rerun rows do not match the manifest's row identities")
    return [ConcreteFold(repeat=fold["repeat"], fold=fold["fold"], train=tuple(fold["trainIndices"]),
                         validation=tuple(fold["validationIndices"]), seed=fold["seed"]) for fold in manifest["folds"]]


def run_child(spec_path: Path, prepare_data: Callable[[Invocation], tuple[Any, list[int], list[str]]],
              run_fold: Callable[..., tuple[dict[str, Any], list[dict[str, Any]]]], stop_requested: Callable[[], bool],
              load_factory: Callable[[Path, str, str], Any], expose: Callable[[Path], None]) -> int:
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    invocation = parse_invocation(spec["invocation"])
    champion = invocation.champion or {}
    source_root = Path(champion["sourceRoot"]).resolve()
    output_dir = invocation.output_dir
    events = EventWriter(output_dir, invocation.experiment_id)
    # Only the champion's source is importable in this interpreter.
    expose(source_root)
    pipeline = champion.get("pipeline", {})
    frozen = dataclasses.replace(invocation, pipeline=PipelineSpec(
        pipeline["module"], pipeline["factory"], pipeline.get("parameters", {}), dict(pipeline.get("estimatorParams", {}))))
    frame, y, ids = prepare_data(invocation)
    manifest = json.loads((output_dir / "fold-manifest.json").read_text(encoding="utf-8"))
    folds = manifest_folds(manifest, ids)
    factory = load_factory(source_root, pipeline["module"], pipeline["factory"])
    events.emit("champion_rerun_started", championExperimentId=champion.get("experimentId"),
                championCommit=champion.get("commit"), folds=len(folds), manifestSha256=manifest["sha256"])
    completed: list[dict[str, Any]] = []
    oof: list[dict[str, Any]] = []
    (output_dir / FOLDS_FILE).unlink(missing_ok=True)
    for fold in folds:
        if stop_requested():
            break
        result, rows = run_fold(frozen, factory, fold, frame, y, ids)
        result["role"] = "champion"
        append_fold_result(output_dir / FOLDS_FILE, result)
        completed.append(result)
        oof.extend(rows)
        events.emit("champion_fold_completed", repeat=fold.repeat, fold=fold.fold,
                    balancedAccuracy=result["metrics"]["balancedAccuracy"], fitSeconds=result["durationSeconds"])
    _write_oof(output_dir / OOF_FILE, oof)
    status = "completed" if len(completed) == len(folds) else "interrupted"
    _atomic_json(output_dir / RESULT_FILE, {"status": status, "completedFolds": len(completed), "requestedFolds": len(folds),
                                            "manifestSha256": manifest["sha256"]})
    events.emit("champion_rerun_finished", status=status, completedFolds=len(completed), requestedFolds=len(folds))
    return 0 if status == "completed" else 2


def rerun(document: dict[str, Any], invocation: Invocation, worker_path: Path, events: EventWriter) -> dict[str, Any]:
    """Run the champion in a child interpreter and return its folds and OOF rows."""
    champion = invocation.champion or {}
    output_dir = invocation.output_dir
    _atomic_json(output_dir / SPEC_FILE, {"invocation": document})
    process = subprocess.run([sys.executable, str(worker_path), "--champion-rerun", str(output_dir / SPEC_FILE)],
                             stdout=sys.stdout, stderr=sys.stderr, check=False)
    folds: list[dict[str, Any]] = []
    if (output_dir / FOLDS_FILE).exists():
        folds = [json.loads(line) for line in (output_dir / FOLDS_FILE).read_text(encoding="utf-8").splitlines() if line.strip()]
    outcome = {"experimentId": champion.get("experimentId"), "commit": champion.get("commit"), "folds": folds,
               "exitCode": process.returncode}
    if not folds:
        outcome["reason"] = f"champion rerun produced no folds (exit code {process.returncode})"
    return outcome


def _oof_rows(path: Path) -> dict[tuple[str, int], int]:
    import csv
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as stream:
        return {(row["id"], int(row["repeat"])): int(row["prediction"]) for row in csv.DictReader(stream, delimiter=";")}


def compare(challenger_folds: Sequence[dict[str, Any]], challenger_oof: Sequence[dict[str, Any]], champion: dict[str, Any],
            labels_by_id: dict[str, int], output_dir: Path) -> dict[str, Any]:
    """Paired differences: challenger minus champion on identical folds and rows."""
    if not champion.get("folds"):
        return {"status": "failed", "championExperimentId": champion.get("experimentId"),
                "championCommit": champion.get("commit"), "reason": champion.get("reason")}
    paired = _paired({"folds": challenger_folds}, fold_scores(champion["folds"]), fold_scores(challenger_folds))
    champion_predictions = _oof_rows(output_dir / OOF_FILE)
    corrected = introduced = 0
    for row in challenger_oof:
        key = (row["id"], int(row["repeat"]))
        if key not in champion_predictions:
            continue
        truth = labels_by_id[row["id"]]
        challenger_right = int(row["prediction"]) == truth
        champion_right = champion_predictions[key] == truth
        corrected += int(challenger_right and not champion_right)
        introduced += int(champion_right and not challenger_right)
    challenger_scores = [fold["metrics"]["balancedAccuracy"] for fold in challenger_folds]
    champion_scores = [fold["metrics"]["balancedAccuracy"] for fold in champion["folds"]]
    return {
        "status": "completed" if len(champion["folds"]) == len(challenger_folds) else "partial",
        "championExperimentId": champion.get("experimentId"),
        "championCommit": champion.get("commit"),
        "challengerMean": sum(challenger_scores) / len(challenger_scores) if challenger_scores else None,
        "championMean": sum(champion_scores) / len(champion_scores),
        "meanDifference": paired.get("meanDifference"),
        "foldsFavoringChallenger": paired.get("foldsFavoringFirst"),
        "foldsFavoringChampion": paired.get("foldsFavoringSecond"),
        "ties": paired.get("ties"),
        "standardError": paired.get("standardError"),
        "leadExceedsNoise": paired.get("leadExceedsNoise"),
        "perFold": paired.get("perFold"),
        "correctedErrors": corrected,
        "introducedErrors": introduced,
    }
