"""Execute one harness-owned cross-validation trial.

The only command-line input is a versioned invocation document.  Agent code is
loaded solely to construct an unfitted estimator and, optionally, describe a
splitter; this worker owns data loading, concrete folds, fitting, predictions,
metrics, persistence, and lifecycle events.
"""
from __future__ import annotations

import argparse
import builtins
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from smartlab_trial.agent_code import (
    _call_pipeline_factory, _factory, _inject_random_states, _load_module, expose_project,
)
from smartlab_trial.artifacts import EventWriter, _atomic_json, _atomic_write, _write_oof, write_summary
from smartlab_trial.folds import ConcreteFold, _manifest, _materialize_folds, _pilot_indices
from smartlab_trial.invocation import SCHEMA_VERSION, InvocationError, Invocation, parse_invocation
from smartlab_trial.metrics import _measure, _scores, score_observation
from smartlab_trial import diagnostics
from smartlab_trial.measurement import kind as measurement_kind, load_samples, selection_receipt
from smartlab_trial.extra_measurements import run as extra_measurements, proxy_score
from smartlab_trial.seeds import _derive_seed
from smartlab_trial.recovery import persisted_folds, save_checkpoint, load_checkpoint, validate_single
from smartlab_trial.convergence import capture_convergence_warnings, summarise_convergence

_stop_requested = False


def _handle_stop(_signum: int, _frame: Any) -> None:
    global _stop_requested
    _stop_requested = True


def _prepare_data(invocation: Invocation) -> tuple[Any, list[Any] | None, list[str]]:
    frame, y, _digest = load_samples(invocation.measurement)
    if invocation.search and y is None and not invocation.search.objective and not invocation.measurement.get("selection"):
        raise InvocationError("Search selection requires a trusted primary metric; label-free trials report proxies only")
    if invocation.scope.kind == "pilot" and invocation.scope.max_rows is not None:
        maximum = min(invocation.scope.max_rows, len(frame))
        selected = _pilot_indices(y if y is not None else [0] * len(frame), maximum,
                                  _derive_seed("pilot", [invocation.trial_seed]))
        frame = frame.iloc[selected].reset_index(drop=True)
        y = [y[index] for index in selected] if y is not None else None
    return frame, y, frame["id"].tolist()


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
                                  if key not in ("sampleManifestPath", "sampleManifestSha256", "evidence", "evidenceManifestSha256")}
    estimator = _call_pipeline_factory(pipeline_factory, context)
    applied = {**invocation.pipeline.estimator_params, **(estimator_params or {})}
    if applied:
        estimator.set_params(**applied)
    # Seeds last: agent values never override harness-owned randomness.
    seeded_parameters = _inject_random_states(estimator, estimator_seed)
    train_frame = frame.iloc[list(fold.train)].reset_index(drop=True)
    validation_frame = frame.iloc[list(fold.validation)].reset_index(drop=True)
    evidence_metadata = frame.attrs.get("diagnosticEvidence")
    # Pandas propagates attrs through slicing; evidence must never enter fit or feature hooks.
    train_frame.attrs.clear()
    validation_frame.attrs.clear()
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
    fixed_selection_promotion = ((invocation.measurement or {}).get("selection") and invocation.scope.kind == "promotion" and invocation.search is None)
    if (task_kind != "anomaly_detection" or fixed_selection_promotion) and predictions is None:
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
    extra, diagnostic_fit_seconds = extra_measurements(invocation, estimator, fold, train_frame, validation_frame,
                                                       predictions, validation_y, scores, evidence_metadata, estimator_seed,
                                                       train_y, signals.get("scoreProvenance"))
    signals.update(extra)
    selection = selection_receipt(invocation.measurement or {}, signals.get("evidence", {}))
    if selection and selection["available"]:
        measurement["selectionScore"] = selection["value"]
    objective = proxy_score(invocation, estimator, validation_frame, validation_y, signals)
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
        "fitSeconds": fit_seconds + diagnostic_fit_seconds,
        "primaryFitSeconds": fit_seconds,
        "diagnosticFitSeconds": diagnostic_fit_seconds,
        "measurementKind": task_kind,
        "execution": "batch" if batch else "inductive",
        "fitRows": len(validation_frame) if batch else len(train_frame),
        "convergence": summarise_convergence(estimator, raised),
    }
    if selection:
        result["selection"] = selection
    if config_id is not None:
        result["configId"] = config_id
    if objective:
        result["searchObjective"] = objective
        result["searchScore"] = objective["value"]
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
    evidence_selection = task_kind == "anomaly_detection" and (invocation.measurement or {}).get("selection")
    if evidence_selection and completed:
        usable = all(fold.get("selection", {}).get("available") is True for fold in completed)
        if usable:
            aggregate = {"selectionScore": float(np.mean([fold["metrics"]["selectionScore"] for fold in completed]))}
        promotion_eligible = promotion_eligible and usable and all(row["prediction"] != "" for row in oof_rows)
    elif task_kind != "classification" and (task_kind == "anomaly_detection" or y is None):
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
        if evidence_selection:
            evidence = invocation.measurement.get("evidence", {})
            summary["selection"] = {**evidence_selection, "evidenceSha256": invocation.measurement.get("evidenceManifestSha256"),
                                    "source": evidence.get("source"), "folds": [fold.get("selection") for fold in completed],
                                    "limitations": "Agent-provided evidence does not establish official accuracy or label correctness"}
        if not promotion_eligible and (task_kind == "anomaly_detection" or y is None):
            summary["promotionIneligibleReason"] = "incomplete_selection_evidence" if evidence_selection else "unlabelled_proxy_evidence"
    return summary


# Fixed-trial folds run in at most this many processes (memory bound per fold).
MAX_FOLD_PROCESSES = 2
_THREAD_VARIABLES = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "BLIS_NUM_THREADS",
                     "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS")


def _fold_plan(total_folds: int, cores: Sequence[int]) -> tuple[int, int]:
    """Fold processes and threads per fold for a fixed trial.

    Depends only on the trial's fold count and the machine's cores, never on
    how many folds remain, so a resumed trial fits every fold with the same
    thread budget. Each process gets its share of the cores rather than one
    thread, so multi-threaded estimators keep the machine's parallelism.
    """
    available = len(cores) or (os.cpu_count() or 1)
    workers = max(1, min(total_folds, available, MAX_FOLD_PROCESSES))
    return workers, max(1, available // workers)


FOLD_PLAN_FILE = "fold-plan.json"


def _recorded_fold_plan(output_dir: Path, total_folds: int, cores: Sequence[int], sequential: bool) -> tuple[int, int]:
    """The trial's fold resource plan, fixed at its first start.

    A resumed trial and its champion rerun reuse the recorded processes and
    threads per process even when the machine now offers different cores, so
    thread-sensitive estimators fit every fold of one trial identity with the
    same thread budget.
    """
    path = output_dir / FOLD_PLAN_FILE
    if path.exists():
        try:
            plan = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            plan = None
        processes = plan.get("processes") if isinstance(plan, dict) else None
        threads = plan.get("threadsPerProcess") if isinstance(plan, dict) else None
        if type(processes) is not int or type(threads) is not int or processes < 1 or threads < 1:
            raise InvocationError(f"Corrupt {FOLD_PLAN_FILE}; restore the trial's recorded fold resource plan. No fit started.")
        return processes, threads
    processes, threads = _fold_plan(1 if sequential else total_folds, cores)
    _atomic_json(path, {"processes": processes, "threadsPerProcess": threads})
    return processes, threads


def _apply_thread_budget(threads: int, cores: Sequence[int] = ()) -> None:
    """Bound this process, and processes it starts, to the recorded thread budget."""
    os.environ.update({name: str(threads) for name in _THREAD_VARIABLES})
    _bound_threads(threads, cores)


def _ids_digest(ids: Sequence[str]) -> str:
    return hashlib.sha256(json.dumps(list(ids), separators=(",", ":")).encode()).hexdigest()


class FoldWorkerError(RuntimeError):
    """A fold process raised an exception type that cannot be rebuilt by name."""


def _rebuild_error(payload: dict[str, Any]) -> BaseException:
    message = str(payload.get("message", ""))
    if payload.get("invocationError"):
        return InvocationError(message)
    builtin = getattr(builtins, str(payload.get("type")), None)
    if isinstance(builtin, type) and issubclass(builtin, Exception):
        try:
            return builtin(message)
        except Exception:
            pass
    return FoldWorkerError(f"{payload.get('type')}: {message}")


def _describe_exit(code: int) -> str:
    if code < 0:
        try:
            return f"killed by signal {signal.Signals(-code).name}"
        except ValueError:
            return f"killed by signal {-code}"
    return f"exit code {code} without a result"


def _die_with_parent() -> None:
    """Fold processes never outlive the trial process (Linux)."""
    if sys.platform != "linux":
        return
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def _bound_threads(threads: int, cores: Sequence[int]) -> None:
    """Apply this fold process's thread budget and core share to every thread."""
    try:
        from threadpoolctl import threadpool_limits
        threadpool_limits(limits=threads)
    except Exception:
        pass
    if cores and hasattr(os, "sched_setaffinity"):
        try:
            for thread in os.listdir("/proc/self/task"):
                os.sched_setaffinity(int(thread), cores)
        except OSError:
            os.sched_setaffinity(0, cores)


def _fold_child(spec_path: Path) -> int:
    """Fit one fold in its own process; the parent owns stop and recording."""
    # A requested stop is the parent's decision: it records completed folds
    # and ends in-flight ones. The block mask is inherited from the parent.
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, signal.SIG_IGN)
    _die_with_parent()
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    _bound_threads(spec["threads"], spec["cores"])
    try:
        document = json.loads(Path(spec["invocation"]).read_text(encoding="utf-8"))
        invocation = parse_invocation(document)
        expose_project(invocation.code_root)
        frame, y, ids = _prepare_data(invocation)
        if _ids_digest(ids) != spec["idsSha256"]:
            raise InvocationError("Fold process loaded different development rows than the trial")
        saved = persisted_folds(invocation, ids)
        if not saved:
            raise InvocationError("Fold process found no fold manifest")
        fold = saved[0][spec["position"]]
        factory = _factory(_load_module(invocation.code_root, invocation.pipeline.module), invocation.pipeline.factory)
        result, rows = _observed_fold(invocation, factory, fold, frame, y, ids)
        _atomic_json(Path(spec["result"]), {"result": result, "rows": rows})
        return 0
    except BaseException as error:
        traceback.print_exc(file=sys.stderr)
        _atomic_json(Path(spec["error"]), {"type": type(error).__name__, "message": str(error),
                                           "invocationError": isinstance(error, InvocationError)})
        return 1


def _launch_fold(work: Path, position: int, threads: int, cores: Sequence[int], ids_digest: str) -> subprocess.Popen:
    spec_path = work / f"{position}.spec.json"
    _atomic_json(spec_path, {"invocation": str(work / "invocation.json"), "position": position, "threads": threads,
                             "cores": list(cores), "idsSha256": ids_digest,
                             "result": str(work / f"{position}.result.json"), "error": str(work / f"{position}.error.json")})
    env = {**os.environ, **{name: str(threads) for name in _THREAD_VARIABLES}}
    # The supervisor stops the whole process group with SIGTERM. Fold
    # processes start with it blocked so only this process decides what a
    # stop means for them (no race before the child installs its handler).
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    try:
        return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--fold", str(spec_path)], env=env)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def _run_fold_processes(document: dict[str, Any], invocation: Invocation, folds: Sequence[ConcreteFold],
                        positions: Sequence[int], ids: Sequence[str], workers: int, threads: int,
                        cores: Sequence[int], record: Any) -> dict[str, Any] | None:
    """Fit pending folds in separate processes; record each fold as it completes.

    Returns None when every pending fold completed, or the interruption: a
    requested stop, or a fold process that ended without a result (killed from
    outside, for example by machine memory protection). A Python exception in
    agent code is re-raised as before and fails the trial.
    """
    work = invocation.output_dir / "fold-work"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    _atomic_json(work / "invocation.json", document)
    digest = _ids_digest(ids)
    queue = list(positions)
    running: dict[int, tuple[subprocess.Popen, int]] = {}
    interruption: dict[str, Any] | None = None

    def collect() -> None:
        nonlocal interruption
        for slot, (process, position) in list(running.items()):
            code = process.poll()
            if code is None:
                continue
            del running[slot]
            result_path, error_path = work / f"{position}.result.json", work / f"{position}.error.json"
            if code == 0 and result_path.exists():
                payload = json.loads(result_path.read_text(encoding="utf-8"))
                record(position, payload["result"], payload["rows"])
            elif error_path.exists():
                raise _rebuild_error(json.loads(error_path.read_text(encoding="utf-8")))
            elif interruption is None and not _stop_requested:
                fold = folds[position]
                interruption = {
                    "reason": "fold_process_ended", "repeat": fold.repeat, "fold": fold.fold, "exitCode": code,
                    "message": (f"The process fitting repeat {fold.repeat} fold {fold.fold} ended without a result "
                                f"({_describe_exit(code)}). It was stopped from outside the trial, for example by "
                                "machine memory protection. Completed folds are recorded; until its missing folds "
                                "complete this trial is not promotion evidence. experiment_resume fits only the "
                                "missing folds with the same plan; if memory caused the stop, reduce the pipeline's "
                                "memory use in a new trial instead."),
                }

    try:
        while queue or running:
            collect()
            if _stop_requested or interruption:
                break
            for slot in range(workers):
                if slot not in running and queue:
                    position = queue.pop(0)
                    running[slot] = (_launch_fold(work, position, threads, cores[slot::workers] if cores else (), digest), position)
            time.sleep(0.05)
        collect()
    finally:
        for process, _ in running.values():
            if process.poll() is None:
                process.kill()
        for process, _ in running.values():
            process.wait()
        shutil.rmtree(work, ignore_errors=True)
    if _stop_requested and interruption is None:
        interruption = {"reason": "stop_requested",
                        "message": "Stopped on request; every completed fold is recorded and in-flight folds were ended."}
    return interruption


def _write_fold_results(path: Path, completed: Sequence[dict[str, Any]]) -> None:
    def write(stream: Any) -> None:
        for result in completed:
            stream.write(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
    _atomic_write(path, write)


def _observed_fold(invocation, factory, fold, frame, y, ids):
    events = EventWriter(invocation.output_dir, invocation.experiment_id)
    events.emit("fold_started", repeat=fold.repeat, fold=fold.fold, trainRows=len(fold.train), validationRows=len(fold.validation))
    with events.stage("fit", repeat=fold.repeat, fold=fold.fold):
        return _run_fold(invocation, factory, fold, frame, y, ids)


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
    cores = tuple(sorted(os.sched_getaffinity(0))) if hasattr(os, "sched_getaffinity") else ()
    workers, threads = _recorded_fold_plan(output_dir, len(folds), cores, invocation.search is not None)
    events.emit("fold_plan", processes=workers, threadsPerProcess=threads, availableCores=len(cores) or os.cpu_count())
    if workers == 1:
        # Folds fit in this process: bound it before agent code loads its libraries.
        _apply_thread_budget(threads)
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
        if invocation.champion and best is not None and not invocation.search.objective and not outcome["stopReason"] and not _stop_requested:
            with events.stage("champion"):
                champion = rerun(document, invocation, Path(__file__).resolve(), events, threads)
        with events.stage("artifacts"):
            outputs = write_search_outputs(invocation, output_dir, outcome, manifest, dict(zip(ids, y)) if y is not None else {}, champion)
            summary = _summarise(invocation, folds, best.folds if best else [], best.oof if best else [],
                                 ids, y, manifest, started, bool(outcome["stopReason"]))
            summary["promotionEligible"] = bool(best and best.status == "completed" and invocation.scope.kind == "promotion" and not invocation.search.objective and not outcome["stopReason"] and len(best.folds) == len(folds) and summary.get("metrics") and best.oof and all(type(row.get("prediction")) is int for row in best.oof))
            if summary["promotionEligible"]:
                from smartlab_trial.search import confirmation_request
                summary["winningPipeline"] = confirmation_request(invocation, best)["pipeline"]
                save_checkpoint(output_dir / "single-checkpoint.json", {"experimentId": invocation.experiment_id, "manifestSha256": manifest["sha256"], "completed": best.folds, "oof": best.oof})
                if champion:
                    from smartlab_trial.champion import compare
                    summary["championComparison"] = compare(best.folds, best.oof, champion, dict(zip(ids, y)) if y is not None else {}, output_dir, task_kind=task_kind)
            if not outcome["stopReason"]:
                summary["status"] = "completed" if best else "failed"
            summary["search"] = {**outputs["report"]["configs"], "bestConfigId": best.config_id if best else None,
                                 "objective": outputs["report"]["objective"], "proxyEvidence": outputs["report"]["proxyEvidence"],
                                 "selectionMean": best.mean if best else None,
                                 "reportPath": str(output_dir / "search-report.json")}
            if outcome["guard"]:
                summary["runtimeGuard"] = outcome["guard"]
            write_summary(output_dir, summary)
        events.emit("trial_finished", status=summary["status"], promotionEligible=summary["promotionEligible"],
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
    done = {(fold["repeat"], fold["fold"]) for fold in completed}
    position_of = {(fold.repeat, fold.fold): index for index, fold in enumerate(folds)}
    pending = [index for index, fold in enumerate(folds) if (fold.repeat, fold.fold) not in done]
    rows_by_position = {position_of[(fold["repeat"], fold["fold"])]: [] for fold in completed}
    for row in oof_rows:
        rows_by_position[position_of[(row["repeat"], row["fold"])]].append(row)
    results_by_position = {position_of[(fold["repeat"], fold["fold"])]: fold for fold in completed}

    def record(position: int, result: dict[str, Any], rows: list[dict[str, Any]]) -> None:
        """Persist one completed fold; folds are kept in manifest order even when they finish out of order."""
        fold = folds[position]
        with events.stage("artifacts", repeat=fold.repeat, fold=fold.fold):
            results_by_position[position] = result
            rows_by_position[position] = rows
            completed[:] = [results_by_position[index] for index in sorted(results_by_position)]
            oof_rows[:] = [row for index in sorted(rows_by_position) for row in rows_by_position[index]]
            save_checkpoint(checkpoint, {"experimentId": invocation.experiment_id, "manifestSha256": manifest["sha256"],
                                         "completed": completed, "oof": oof_rows})
            _write_fold_results(output_dir / "fold-results.jsonl", completed)
            _write_oof(output_dir / "oof_predictions.csv", oof_rows)
        events.emit("fold_completed", repeat=fold.repeat, fold=fold.fold, metrics=result["metrics"], durationSeconds=result["durationSeconds"])

    interruption = None
    if workers == 1:
        for position in pending:
            if _stop_requested:
                break
            result, rows = _observed_fold(invocation, pipeline_factory, folds[position], frame, y, ids)
            record(position, result, rows)
        if _stop_requested:
            interruption = {"reason": "stop_requested", "message": "Stopped on request; every completed fold is recorded."}
    elif pending:
        events.emit("fold_processes", processes=min(workers, len(pending)), threadsPerFold=threads, pendingFolds=len(pending))
        interruption = _run_fold_processes(document, invocation, folds, pending, ids, workers, threads, cores, record)
    if interruption is None and _stop_requested:
        interruption = {"reason": "stop_requested", "message": "Stopped on request after the last fold completed; every fold is recorded."}

    with events.stage("metrics"):
        summary = _summarise(invocation, folds, completed, oof_rows, ids, y, manifest, started, interruption is not None)
        if interruption:
            summary["interruption"] = interruption
    if invocation.champion and summary["status"] == "completed" and summary["promotionEligible"] and not _stop_requested:
        from smartlab_trial.champion import rerun, compare
        with events.stage("champion"):
            champion = rerun(document, invocation, Path(__file__).resolve(), events, threads)
            summary["championComparison"] = compare(completed, oof_rows, champion, dict(zip(ids, y)) if y is not None else {}, output_dir,
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
    mode.add_argument("--fold", type=Path)
    arguments = parser.parse_args(argv)
    if arguments.fold:
        return _fold_child(arguments.fold)
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    if arguments.champion_rerun:
        from smartlab_trial.champion import run_child
        # The champion fits sequentially with the challenger's recorded thread budget.
        threads = json.loads(arguments.champion_rerun.read_text(encoding="utf-8")).get("threadsPerProcess")
        if type(threads) is int and threads >= 1:
            _apply_thread_budget(threads)
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
