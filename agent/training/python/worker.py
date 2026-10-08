"""Execute one harness-owned cross-validation trial.

The only command-line input is a versioned invocation document.  Agent code is
loaded solely to construct an unfitted estimator and, optionally, describe a
splitter; this worker owns data loading, concrete folds, fitting, predictions,
metrics, persistence, and lifecycle events.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from smartlab_eval import load_labelled

from smartlab_trial.agent_code import (
    _call_pipeline_factory, _factory, _inject_random_states, _load_module, expose_project,
)
from smartlab_trial.artifacts import EventWriter, _atomic_json, _write_oof, append_fold_result, write_summary
from smartlab_trial.folds import ConcreteFold, _manifest, _materialize_folds, _pilot_indices
from smartlab_trial.invocation import SCHEMA_VERSION, InvocationError, Invocation, parse_invocation
from smartlab_trial.metrics import _measure, _scores, score_observation
from smartlab_trial import diagnostics
from smartlab_trial.measurement import kind as measurement_kind, load_samples
from smartlab_trial.seeds import _derive_seed
from smartlab_trial.recovery import persisted_folds, save_checkpoint, load_checkpoint, validate_single
from smartlab_trial.convergence import capture_convergence_warnings, summarise_convergence

_stop_requested = False


def _handle_stop(_signum: int, _frame: Any) -> None:
    global _stop_requested
    _stop_requested = True


def _prepare_data(invocation: Invocation) -> tuple[Any, list[Any] | None, list[str]]:
    if invocation.measurement:
        frame, y, _digest = load_samples(invocation.measurement)
        if invocation.search and y is None:
            raise InvocationError("Search selection requires a trusted primary metric; label-free trials report proxies only")
        if invocation.scope.kind == "pilot" and invocation.scope.max_rows is not None:
            maximum = min(invocation.scope.max_rows, len(frame))
            selected = _pilot_indices(y if y is not None else [0] * len(frame), maximum,
                                      _derive_seed("pilot", [invocation.trial_seed]))
            frame = frame.iloc[selected].reset_index(drop=True)
            y = [y[index] for index in selected] if y is not None else None
        return frame, y, frame["id"].tolist()
    frame, y = load_labelled(invocation.zip_path, invocation.labels_path)
    # Stable input order makes folds independent of labels-file ordering.
    order = np.argsort(frame["id"].astype(str).to_numpy(), kind="stable")
    frame = frame.iloc[order].reset_index(drop=True)
    y = [int(y[index]) for index in order]
    scope = invocation.scope
    if scope.kind == "pilot" and scope.max_rows is not None:
        selected = _pilot_indices(y, min(scope.max_rows, len(y)), _derive_seed("pilot", [invocation.trial_seed]))
        frame = frame.iloc[selected].reset_index(drop=True)
        y = [y[index] for index in selected]
    return frame, y, [str(value) for value in frame["id"]]


def _run_fold(invocation: Invocation, pipeline_factory: Any, fold: ConcreteFold,
              frame: Any, y: Sequence[Any] | None, ids: Sequence[str], *,
              factory_parameters: Any = None, estimator_params: dict[str, Any] | None = None,
              estimator_index: int = 0, config_id: str | None = None,
              convergence: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Fit one fold. Search configurations pass their own parameters and index.

    Configuration 0 uses exactly the single-trial seeds, so a fixed-parameter
    rerun of a search's first configuration reproduces it on the same folds.
    """
    fold_started = time.monotonic()
    estimator_seed = _derive_seed("estimator", [fold.seed, estimator_index])
    parameters = invocation.pipeline.parameters if factory_parameters is None else factory_parameters
    context = {"parameters": parameters, "seed": estimator_seed}
    if invocation.measurement:
        context["measurement"] = {key: value for key, value in invocation.measurement.items()
                                  if key not in ("sampleManifestPath", "sampleManifestSha256")}
    estimator = _call_pipeline_factory(pipeline_factory, context)
    applied = {**invocation.pipeline.estimator_params, **(estimator_params or {})}
    if applied:
        estimator.set_params(**applied)
    # Seeds last: agent values never override harness-owned randomness.
    seeded_parameters = _inject_random_states(estimator, estimator_seed)
    train_frame = frame.iloc[list(fold.train)].reset_index(drop=True)
    validation_frame = frame.iloc[list(fold.validation)].reset_index(drop=True)
    train_y = [y[index] for index in fold.train] if y is not None else None
    validation_y = [y[index] for index in fold.validation] if y is not None else None
    task_kind = measurement_kind(invocation)
    batch = invocation.measurement is not None and invocation.measurement["execution"] == "batch"
    fit_started = time.monotonic()
    with capture_convergence_warnings() as raised:
        if task_kind == "classification":
            estimator.fit(train_frame, train_y)
        elif batch and callable(getattr(estimator, "fit_predict", None)):
            predictions = estimator.fit_predict(validation_frame)
        else:
            estimator.fit(validation_frame if batch else train_frame)
    fit_seconds = time.monotonic() - fit_started
    if not (batch and callable(getattr(estimator, "fit_predict", None))):
        predictions = estimator.predict(validation_frame) if callable(getattr(estimator, "predict", None)) else None
    if predictions is not None:
        values = diagnostics.finite_vector(predictions, len(validation_frame), "Predictions")
        if np.any(values != np.floor(values)):
            raise InvocationError("Predictions must be integer labels")
        predictions = values.astype(int).tolist()
    if task_kind != "anomaly_detection" and predictions is None:
        raise InvocationError("Pipeline must supply predictions for this measurement kind")
    scores = None
    if task_kind == "classification":
        if any(value not in (0, 1) for value in predictions):
            raise InvocationError("Classification predictions must be 0 or 1")
        scores, provenance = score_observation(estimator, validation_frame)
        measurement = _measure(validation_y, predictions)
        signals = diagnostics.classification(validation_y, predictions, scores, provenance)
    elif task_kind == "clustering":
        signals = diagnostics.clustering(validation_y, predictions)
        measurement = ({"adjustedRandIndex": signals["external"]["adjustedRandIndex"]}
                       if signals["external"]["available"] else {})
    else:
        spec = invocation.measurement
        score_fn = getattr(estimator, spec["scoreMethod"], None)
        if spec["scoreMethod"] == "negative_outlier_factor_":
            raw_scores = score_fn
        elif callable(score_fn):
            raw_scores = score_fn(validation_frame)
        else:
            raise InvocationError("Pipeline lacks the declared anomaly score method")
        scores = diagnostics.finite_vector(raw_scores, len(validation_frame), "Anomaly scores").tolist()
        signals = diagnostics.anomaly(scores, predictions, direction=spec["scoreDirection"], anomaly_label=spec["anomalyLabel"])
        signals["scoreProvenance"] = {"kind": "anomaly", "method": spec["scoreMethod"], "direction": spec["scoreDirection"]}
        measurement = {}
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": invocation.experiment_id,
        "repeat": fold.repeat,
        "fold": fold.fold,
        "seed": fold.seed,
        "trainRows": len(fold.train),
        "validationRows": len(fold.validation),
        "durationSeconds": time.monotonic() - fold_started,
        "seededParameters": seeded_parameters,
        "metrics": measurement,
        "diagnostics": signals,
        "fitSeconds": fit_seconds,
        "measurementKind": task_kind,
        "execution": "batch" if batch else "inductive",
        "fitRows": len(validation_frame) if batch else len(train_frame),
        "convergence": summarise_convergence(estimator, raised),
    }
    if config_id is not None:
        result["configId"] = config_id
        result["fitSeconds"] = fit_seconds
    rows: list[dict[str, Any]] = []
    for offset, index in enumerate(fold.validation):
        rows.append({
            "id": ids[index],
            "repeat": fold.repeat,
            "fold": fold.fold,
            "prediction": predictions[offset] if predictions is not None else "",
            "score": "" if scores is None else scores[offset],
        })
    return result, rows


def _summarise(invocation: Invocation, folds: Sequence[ConcreteFold], completed: Sequence[dict[str, Any]],
               oof_rows: Sequence[dict[str, Any]], ids: Sequence[str], y: Sequence[Any] | None,
               manifest: dict[str, Any], started: float, interrupted: bool) -> dict[str, Any]:
    complete = len(completed) == len(folds) and not interrupted
    promotion_eligible = invocation.scope.kind == "promotion" and complete
    aggregate = None
    task_kind = measurement_kind(invocation)
    if oof_rows and task_kind == "classification":
        labels_by_id = {ids[index]: int(y[index]) for index in range(len(ids))}
        aggregate = _measure(
            [labels_by_id[row["id"]] for row in oof_rows],
            [int(row["prediction"]) for row in oof_rows],
        )
    elif task_kind == "clustering" and y is not None and completed:
        aggregate = {"adjustedRandIndex": float(np.mean([fold["metrics"]["adjustedRandIndex"] for fold in completed])),
                     "aggregation": "mean of validation-batch ARI; cluster IDs never pooled"}
    if task_kind != "classification" and (task_kind == "anomaly_detection" or y is None):
        promotion_eligible = False
    status = "interrupted" if interrupted else ("completed" if complete else "partial")
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": invocation.experiment_id,
        "status": status,
        "scope": invocation.scope.kind,
        "promotionEligible": promotion_eligible,
        "requestedFolds": len(folds),
        "completedFolds": len(completed),
        "rows": len(ids),
        "manifestSha256": manifest["sha256"],
        "durationSeconds": time.monotonic() - started,
        "metrics": aggregate,
        "measurementKind": task_kind,
        "diagnostics": diagnostics.summary(task_kind, completed, oof_rows,
                                            (invocation.measurement or {}).get("scoreDirection", "higher_is_anomalous")),
    }
    if invocation.source:
        # Commit, tree, branch, and subject: a score traces back to exact code.
        summary["source"] = {key: invocation.source[key] for key in ("commit", "tree", "branch", "subject")
                             if invocation.source.get(key) is not None}
    if invocation.measurement:
        summary["measurement"] = invocation.measurement
        if task_kind == "anomaly_detection" or y is None:
            summary["promotionIneligibleReason"] = "unlabelled_proxy_evidence"
    return summary


def execute(document: dict[str, Any]) -> dict[str, Any]:
    global _stop_requested
    _stop_requested = False
    invocation = parse_invocation(document)
    task_kind = measurement_kind(invocation)
    # Agent code always comes from the trial's own source: a worktree of the
    # recorded commit for versioned trials, never the live, mutable folder.
    project_root = invocation.code_root
    expose_project(project_root)
    output_dir = invocation.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    events = EventWriter(output_dir, invocation.experiment_id)
    started = time.monotonic()
    events.emit("trial_started", scope=invocation.scope.kind, hypothesis=invocation.hypothesis,
                **({"source": invocation.source} if invocation.source else {}))
    events.emit("action_completed", stage="invocation", scope=invocation.scope.kind,
                cvKind=invocation.cv.kind, repeats=invocation.cv.repeats)
    events.emit("action_completed", stage="seeds", experimentSeed=invocation.experiment_seed,
                trialSeed=invocation.trial_seed)

    with events.stage("data"):
        frame, y, ids = _prepare_data(invocation)
        events.emit("data_loaded", rows=len(frame), measurementKind=measurement_kind(invocation),
                    measurement=invocation.measurement,
                    classCounts={str(label): y.count(label) for label in sorted(set(y))} if y is not None else None)
    with events.stage("folds"):
        saved = persisted_folds(invocation, ids)
        if saved:
            folds, manifest = saved
        else:
            folds = _materialize_folds(invocation.cv, invocation.scope, frame, y, project_root, invocation.trial_seed)
            manifest = _manifest(invocation.experiment_id, ids, folds, invocation.scope, invocation.trial_seed)
            _atomic_json(output_dir / "fold-manifest.json", manifest)
        events.emit("folds_materialized", folds=len(folds), manifestSha256=manifest["sha256"])
    with events.stage("agent_code"):
        pipeline = invocation.pipeline
        pipeline_factory = _factory(_load_module(project_root, pipeline.module), pipeline.factory)

    completed: list[dict[str, Any]] = []
    oof_rows: list[dict[str, Any]] = []
    if invocation.search is not None:
        from smartlab_trial.search import run_search, write_search_outputs
        from smartlab_trial.champion import rerun
        with events.stage("search"):
            outcome = run_search(invocation, events, output_dir, pipeline_factory, folds, frame, y, ids,
                                 lambda: _stop_requested, _run_fold)
        best = outcome["best"]
        champion = None
        if invocation.champion and best is not None and not outcome["stopReason"] and not _stop_requested:
            with events.stage("champion"):
                champion = rerun(document, invocation, Path(__file__).resolve(), events)
        with events.stage("artifacts"):
            outputs = write_search_outputs(invocation, output_dir, outcome, manifest, dict(zip(ids, y)) if y is not None else {}, champion)
            summary = _summarise(invocation, folds, best.folds if best else [], best.oof if best else [],
                                 ids, y, manifest, started, bool(outcome["stopReason"]))
            summary["promotionEligible"] = False
            if not outcome["stopReason"]:
                summary["status"] = "completed" if best else "failed"
            summary["search"] = {**outputs["report"]["configs"], "bestConfigId": best.config_id if best else None,
                                 "reportPath": str(output_dir / "search-report.json")}
            if outcome["guard"]:
                summary["runtimeGuard"] = outcome["guard"]
            write_summary(output_dir, summary)
        events.emit("trial_finished", status=summary["status"], promotionEligible=False,
                    completedFolds=summary["completedFolds"], requestedFolds=len(folds), metrics=summary["metrics"])
        return summary
    checkpoint = output_dir / "single-checkpoint.json"
    if checkpoint.exists():
        previous = load_checkpoint(checkpoint)
        completed, oof_rows = validate_single(previous, invocation, manifest, folds, ids)
        events.emit("single_resumed", completedFolds=len(completed), requestedFolds=len(folds),
                    note="Atomic completed folds retained; incomplete opaque fit repeated with original seed")
        # Rebuild derived artifacts if a crash interrupted their publication.
        (output_dir / "fold-results.jsonl").write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in completed))
        _write_oof(output_dir / "oof_predictions.csv", oof_rows)
    elif (output_dir / "fold-results.jsonl").exists():
        raise InvocationError("Legacy single-trial fold results lack atomic prediction checkpoint; cannot safely resume; start a new trial")
    for fold in folds[len(completed):]:
        if _stop_requested:
            break
        events.emit("fold_started", repeat=fold.repeat, fold=fold.fold, trainRows=len(fold.train), validationRows=len(fold.validation))
        with events.stage("fit", repeat=fold.repeat, fold=fold.fold):
            result, rows = _run_fold(invocation, pipeline_factory, fold, frame, y, ids)
        with events.stage("artifacts", repeat=fold.repeat, fold=fold.fold):
            completed.append(result)
            oof_rows.extend(rows)
            save_checkpoint(checkpoint, {"experimentId": invocation.experiment_id, "manifestSha256": manifest["sha256"],
                                         "completed": completed, "oof": oof_rows})
            append_fold_result(output_dir / "fold-results.jsonl", result)
            _write_oof(output_dir / "oof_predictions.csv", oof_rows)
        events.emit("fold_completed", repeat=fold.repeat, fold=fold.fold, metrics=result["metrics"], durationSeconds=result["durationSeconds"])

    with events.stage("metrics"):
        summary = _summarise(invocation, folds, completed, oof_rows, ids, y, manifest, started, _stop_requested)
    if invocation.champion and summary["status"] == "completed" and summary["promotionEligible"] and not _stop_requested:
        from smartlab_trial.champion import rerun, compare
        with events.stage("champion"):
            champion = rerun(document, invocation, Path(__file__).resolve(), events)
            summary["championComparison"] = compare(completed, oof_rows, champion, dict(zip(ids, y)), output_dir,
                                                    task_kind=task_kind)
    with events.stage("artifacts"):
        write_summary(output_dir, summary)
    events.emit("trial_finished", status=summary["status"], promotionEligible=summary["promotionEligible"],
                completedFolds=len(completed), requestedFolds=len(folds), metrics=summary["metrics"])
    return summary


def _failure_result(document: dict[str, Any], error: BaseException) -> None:
    inputs = document.get("inputs", {})
    output = inputs.get("outputDir")
    if not isinstance(output, str) or not output:
        return
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": document.get("experimentId"),
        "status": "failed",
        "promotionEligible": False,
        "error": {"type": type(error).__name__, "message": str(error)},
    }
    _atomic_json(output_dir / "trial-result.json", result)
    try:
        EventWriter(output_dir, str(document.get("experimentId", "unknown"))).emit(
            "trial_failed", error=result["error"]
        )
    except Exception:
        pass


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--invocation", type=Path)
    mode.add_argument("--champion-rerun", type=Path)
    arguments = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    if arguments.champion_rerun:
        from smartlab_trial.champion import run_child
        return run_child(arguments.champion_rerun, _prepare_data, _run_fold, lambda: _stop_requested,
                         lambda root, module, factory: _factory(_load_module(root, module), factory), expose_project)
    document: dict[str, Any] = {}
    try:
        document = json.loads(arguments.invocation.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise InvocationError("invocation root must be an object")
        result = execute(document)
        return 0 if result["status"] == "completed" else 2
    except BaseException as error:
        _failure_result(document, error)
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
