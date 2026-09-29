"""Execute one harness-owned cross-validation trial.

The only command-line input is a versioned invocation document.  Agent code is
loaded solely to construct an unfitted estimator and, optionally, describe a
splitter; this worker owns data loading, concrete folds, fitting, predictions,
metrics, persistence, and lifecycle events.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import inspect
import json
import os
import signal
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Iterable, Sequence

import numpy as np
from sklearn.metrics import balanced_accuracy_score, confusion_matrix, recall_score
from sklearn.model_selection import StratifiedKFold, train_test_split
from smartlab_eval import load_labelled


SCHEMA_VERSION = 1
_stop_requested = False


class InvocationError(ValueError):
    """The invocation or agent-provided factory violates the worker contract."""


@dataclass(frozen=True)
class ConcreteFold:
    repeat: int
    fold: int
    train: tuple[int, ...]
    validation: tuple[int, ...]
    seed: int


class EventWriter:
    def __init__(self, output_dir: Path, experiment_id: str) -> None:
        self.path = output_dir / "events.jsonl"
        self.experiment_id = experiment_id

    def emit(self, kind: str, **data: Any) -> None:
        event = {
            "schemaVersion": SCHEMA_VERSION,
            "experimentId": self.experiment_id,
            "type": kind,
            "timestamp": time.time(),
            **_jsonable(data),
        }
        line = json.dumps(event, sort_keys=True, separators=(",", ":"), allow_nan=False)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
            stream.flush()
        print(line, flush=True)


def _handle_stop(_signum: int, _frame: Any) -> None:
    global _stop_requested
    _stop_requested = True


def _derive_seed(domain: str, components: Sequence[object]) -> int:
    """Match the persisted TypeScript seed plan's domain-separated derivation."""
    material = json.dumps({
        "namespace": "auto-smart-lab.seed",
        "version": 1,
        "derivation": "sha256-domain-separated-uint32-v1",
        "domain": domain,
        "components": list(components),
    }, separators=(",", ":")).encode("utf-8")
    return int.from_bytes(hashlib.sha256(material).digest()[:4], "big")


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    return value


def _atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(_jsonable(document), stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _object(document: dict[str, Any], key: str) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        raise InvocationError(f"{key} must be an object")
    return value


def _validate_invocation(document: dict[str, Any]) -> None:
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise InvocationError(f"schemaVersion must be {SCHEMA_VERSION}")
    if not isinstance(document.get("experimentId"), str) or not document["experimentId"]:
        raise InvocationError("experimentId must be a non-empty string")
    request = _object(document, "request")
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise InvocationError(f"request.schemaVersion must be {SCHEMA_VERSION}")
    if not isinstance(request.get("hypothesis"), str) or not request["hypothesis"].strip():
        raise InvocationError("request.hypothesis must be a non-empty string")
    pipeline = _object(request, "pipeline")
    if not isinstance(pipeline.get("module"), str) or not pipeline["module"].endswith(".py"):
        raise InvocationError("request.pipeline.module must name a project-relative .py file")
    if not isinstance(pipeline.get("factory"), str) or not pipeline["factory"]:
        raise InvocationError("request.pipeline.factory must be a non-empty string")
    cv = _object(request, "cv")
    if cv.get("kind") == "builtin" and cv.get("scheme") == "stratified_kfold":
        if not isinstance(cv.get("folds"), int) or cv["folds"] < 2:
            raise InvocationError("built-in stratified_kfold requires folds >= 2")
    elif cv.get("kind") == "factory":
        if not isinstance(cv.get("module"), str) or not cv["module"].endswith(".py"):
            raise InvocationError("custom CV requires a project-relative .py module")
        if not isinstance(cv.get("factory"), str) or not cv["factory"]:
            raise InvocationError("custom CV requires a factory name")
    else:
        raise InvocationError("request.cv must select kind=builtin with scheme=stratified_kfold or kind=factory")
    if not isinstance(cv.get("repeats", 1), int) or cv.get("repeats", 1) < 1:
        raise InvocationError("request.cv.repeats must be >= 1")
    scope = _object(request, "scope")
    if scope.get("kind") not in {"pilot", "promotion"}:
        raise InvocationError("request.scope.kind must be pilot or promotion")
    for name in ("maxRows", "maxFolds"):
        if name in scope and (not isinstance(scope[name], int) or scope[name] < 1):
            raise InvocationError(f"request.scope.{name} must be a positive integer")
    inputs = _object(document, "inputs")
    for name in ("projectRoot", "zipPath", "labelsPath", "outputDir"):
        if not isinstance(inputs.get(name), str) or not inputs[name]:
            raise InvocationError(f"inputs.{name} must be a non-empty path")
    seeds = _object(document, "seeds")
    if not isinstance(seeds.get("experiment"), int) or not 0 <= seeds["experiment"] < 2**32:
        raise InvocationError("seeds.experiment must be an unsigned 32-bit integer")
    if "trial" in seeds and (not isinstance(seeds["trial"], int) or not 0 <= seeds["trial"] < 2**32):
        raise InvocationError("seeds.trial must be an unsigned 32-bit integer")


def _inside_project(project_root: Path, relative: str) -> Path:
    candidate = (project_root / relative).resolve()
    try:
        candidate.relative_to(project_root)
    except ValueError as error:
        raise InvocationError(f"module escapes project root: {relative!r}") from error
    if not candidate.is_file():
        raise InvocationError(f"module does not exist: {relative!r}")
    return candidate


def _load_module(project_root: Path, relative: str) -> ModuleType:
    path = _inside_project(project_root, relative)
    identity = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    spec = importlib.util.spec_from_file_location(f"smartlab_agent_{identity}", path)
    if spec is None or spec.loader is None:
        raise InvocationError(f"cannot load module {relative!r}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _factory(module: ModuleType, name: str) -> Any:
    value = getattr(module, name, None)
    if not callable(value):
        raise InvocationError(f"factory {name!r} is missing or not callable")
    return value


def _call_pipeline_factory(factory: Any, context: dict[str, Any]) -> Any:
    signature = inspect.signature(factory)
    try:
        signature.bind(context)
    except TypeError:
        try:
            signature.bind()
        except TypeError as error:
            raise InvocationError("pipeline factory must accept either zero arguments or one context") from error
        estimator = factory()
    else:
        estimator = factory(context)
    if not callable(getattr(estimator, "fit", None)) or not callable(getattr(estimator, "predict", None)):
        raise InvocationError("pipeline factory must return an estimator with fit() and predict()")
    return estimator


def _inject_random_states(estimator: Any, seed: int) -> list[str]:
    """Make exposed sklearn randomness harness-owned, including nested steps."""
    if not callable(getattr(estimator, "get_params", None)) or not callable(getattr(estimator, "set_params", None)):
        return []
    keys = sorted(key for key in estimator.get_params(deep=True) if key == "random_state" or key.endswith("__random_state"))
    values = {key: _derive_seed("estimator_parameter", [seed, key]) for key in keys}
    if values:
        estimator.set_params(**values)
    return keys


def _pilot_indices(y: Sequence[int], maximum: int, seed: int) -> list[int]:
    if maximum >= len(y):
        return list(range(len(y)))
    if maximum < 2:
        raise InvocationError("pilot maxRows must leave enough rows to represent both classes")
    all_indices = np.arange(len(y))
    labels, counts = np.unique(y, return_counts=True)
    stratify = y if len(labels) > 1 and maximum >= len(labels) and np.all(counts >= 2) else None
    selected, _ = train_test_split(
        all_indices,
        train_size=maximum,
        random_state=seed,
        shuffle=True,
        stratify=stratify,
    )
    return sorted(int(index) for index in selected)


def _as_indices(values: Iterable[Any], name: str, row_count: int) -> tuple[int, ...]:
    try:
        indices = tuple(int(value) for value in values)
    except (TypeError, ValueError) as error:
        raise InvocationError(f"{name} indices must be an iterable of integers") from error
    if not indices:
        raise InvocationError(f"{name} indices must not be empty")
    if len(set(indices)) != len(indices):
        raise InvocationError(f"{name} indices contain duplicates")
    if min(indices) < 0 or max(indices) >= row_count:
        raise InvocationError(f"{name} indices are outside the {row_count}-row corpus")
    return indices


def _normalise_splits(raw: Any, frame: Any, y: Sequence[int]) -> list[tuple[Iterable[Any], Iterable[Any]]]:
    if callable(getattr(raw, "split", None)):
        raw = raw.split(frame, y)
    try:
        return list(raw)
    except TypeError as error:
        raise InvocationError("CV factory must return a splitter or iterable of (train, validation) pairs") from error


def _materialize_folds(
    request: dict[str, Any], frame: Any, y: Sequence[int], project_root: Path, base_seed: int
) -> list[ConcreteFold]:
    cv = request["cv"]
    repeats = cv.get("repeats", 1)
    materialized: list[ConcreteFold] = []
    custom_factory = None
    if cv["kind"] == "factory":
        custom_factory = _factory(_load_module(project_root, cv["module"]), cv["factory"])
    for repeat in range(repeats):
        repeat_seed = _derive_seed("repeat", [base_seed, repeat])
        if cv["kind"] == "builtin":
            splitter = StratifiedKFold(n_splits=cv["folds"], shuffle=True, random_state=repeat_seed)
            pairs = list(splitter.split(frame, y))
        else:
            raw = custom_factory({
                "frame": frame.copy(),
                "y": list(y),
                "seed": repeat_seed,
                "repeat": repeat,
                "options": cv.get("options", {}),
            })
            pairs = _normalise_splits(raw, frame, y)
        if not pairs:
            raise InvocationError(f"CV repeat {repeat} produced no folds")
        for fold_number, pair in enumerate(pairs):
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise InvocationError("each CV split must be a (train, validation) pair")
            train = _as_indices(pair[0], "train", len(frame))
            validation = _as_indices(pair[1], "validation", len(frame))
            overlap = set(train).intersection(validation)
            if overlap:
                raise InvocationError(f"repeat {repeat} fold {fold_number} train/validation overlap")
            materialized.append(ConcreteFold(
                repeat=repeat,
                fold=fold_number,
                train=train,
                validation=validation,
                seed=_derive_seed("fold", [repeat_seed, fold_number]),
            ))
    max_folds = request["scope"].get("maxFolds")
    if request["scope"]["kind"] == "pilot" and max_folds is not None:
        materialized = materialized[:max_folds]
    _validate_coverage(materialized, len(frame), repeats, request["scope"]["kind"] == "promotion")
    return materialized


def _validate_coverage(folds: Sequence[ConcreteFold], row_count: int, repeats: int, promotion: bool) -> None:
    by_repeat: dict[int, list[int]] = {repeat: [] for repeat in range(repeats)}
    for fold in folds:
        by_repeat[fold.repeat].extend(fold.validation)
    if promotion:
        expected = list(range(row_count))
        for repeat, observed in by_repeat.items():
            if sorted(observed) != expected:
                raise InvocationError(
                    f"promotion repeat {repeat} must validate every row exactly once; "
                    f"received {len(observed)} assignments for {row_count} rows"
                )


def _manifest(experiment_id: str, frame: Any, folds: Sequence[ConcreteFold], request: dict[str, Any], seed: int) -> dict[str, Any]:
    rows = [
        {"id": str(frame.iloc[index]["id"]), "index": index, "repeat": fold.repeat, "fold": fold.fold}
        for fold in folds
        for index in fold.validation
    ]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": experiment_id,
        "scope": request["scope"]["kind"],
        "seed": seed,
        "rowCount": len(frame),
        "foldCount": len(folds),
        "assignments": rows,
        "folds": [
            {
                "repeat": fold.repeat,
                "fold": fold.fold,
                "seed": fold.seed,
                "trainIndices": list(fold.train),
                "validationIndices": list(fold.validation),
            }
            for fold in folds
        ],
    }
    digest_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload["sha256"] = hashlib.sha256(digest_payload.encode("utf-8")).hexdigest()
    return payload


def _scores(estimator: Any, validation: Any) -> list[float] | None:
    if callable(getattr(estimator, "predict_proba", None)):
        probabilities = np.asarray(estimator.predict_proba(validation))
        if probabilities.ndim == 2 and probabilities.shape[1] == 2:
            return [float(value) for value in probabilities[:, 1]]
    if callable(getattr(estimator, "decision_function", None)):
        values = np.asarray(estimator.decision_function(validation))
        if values.ndim == 1:
            return [float(value) for value in values]
    return None


def _measure(truth: Sequence[int], predicted: Sequence[int]) -> dict[str, Any]:
    labels = sorted(set(int(value) for value in truth))
    recalls = recall_score(truth, predicted, labels=labels, average=None, zero_division=0)
    return {
        "balancedAccuracy": float(balanced_accuracy_score(truth, predicted)),
        "perClassRecall": {str(label): float(value) for label, value in zip(labels, recalls)},
        "confusionMatrix": confusion_matrix(truth, predicted, labels=labels).tolist(),
        "labels": labels,
    }


def _write_oof(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=["id", "repeat", "fold", "prediction", "score"],
                delimiter=";",
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(rows)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def execute(document: dict[str, Any]) -> dict[str, Any]:
    global _stop_requested
    _stop_requested = False
    _validate_invocation(document)
    experiment_id = document["experimentId"]
    request = document["request"]
    inputs = document["inputs"]
    # The experiment seed is the only entropy root.  Every repeat/fold/estimator
    # seed is derived locally, so callers cannot accidentally provide a
    # contradictory collection of per-fit seeds.
    experiment_seed = document["seeds"]["experiment"]
    # Old hand-authored fixtures may omit the trial coordinate; durable service
    # invocations persist it explicitly so replay never has to reconstruct it.
    base_seed = document["seeds"].get("trial", _derive_seed("trial", [experiment_seed, 0]))
    project_root = Path(inputs["projectRoot"]).resolve()
    if not project_root.is_dir():
        raise InvocationError("inputs.projectRoot must be an existing directory")
    # Agent entrypoints routinely import reusable helpers elsewhere under
    # solutions/. A dedicated worker process may safely expose the declared
    # project root for those imports without injecting harness internals.
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    output_dir = Path(inputs["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    events = EventWriter(output_dir, experiment_id)
    started = time.monotonic()
    events.emit("trial_started", scope=request["scope"]["kind"], hypothesis=request.get("hypothesis", ""))

    frame, y = load_labelled(inputs["zipPath"], inputs["labelsPath"])
    # Stable input order makes folds independent of labels-file ordering.
    order = np.argsort(frame["id"].astype(str).to_numpy(), kind="stable")
    frame = frame.iloc[order].reset_index(drop=True)
    y = [int(y[index]) for index in order]
    scope = request["scope"]
    if scope["kind"] == "pilot" and scope.get("maxRows") is not None:
        selected = _pilot_indices(y, min(scope["maxRows"], len(y)), _derive_seed("pilot", [base_seed]))
        frame = frame.iloc[selected].reset_index(drop=True)
        y = [y[index] for index in selected]
    events.emit("data_loaded", rows=len(frame), classCounts={str(label): y.count(label) for label in sorted(set(y))})

    folds = _materialize_folds(request, frame, y, project_root, base_seed)
    manifest = _manifest(experiment_id, frame, folds, request, base_seed)
    _atomic_json(output_dir / "fold-manifest.json", manifest)
    events.emit("folds_materialized", folds=len(folds), manifestSha256=manifest["sha256"])

    pipeline_spec = request["pipeline"]
    pipeline_factory = _factory(_load_module(project_root, pipeline_spec["module"]), pipeline_spec["factory"])
    completed: list[dict[str, Any]] = []
    oof_rows: list[dict[str, Any]] = []
    result_path = output_dir / "fold-results.jsonl"
    for fold in folds:
        if _stop_requested:
            break
        events.emit("fold_started", repeat=fold.repeat, fold=fold.fold, trainRows=len(fold.train), validationRows=len(fold.validation))
        fold_started = time.monotonic()
        estimator_seed = _derive_seed("estimator", [fold.seed, 0])
        context = {"parameters": pipeline_spec.get("parameters", {}), "seed": estimator_seed}
        estimator = _call_pipeline_factory(pipeline_factory, context)
        seeded_parameters = _inject_random_states(estimator, estimator_seed)
        train_frame = frame.iloc[list(fold.train)].reset_index(drop=True)
        validation_frame = frame.iloc[list(fold.validation)].reset_index(drop=True)
        train_y = [y[index] for index in fold.train]
        validation_y = [y[index] for index in fold.validation]
        estimator.fit(train_frame, train_y)
        predictions = [int(value) for value in estimator.predict(validation_frame)]
        if len(predictions) != len(validation_y):
            raise InvocationError("pipeline predict() returned the wrong number of rows")
        scores = _scores(estimator, validation_frame)
        measurement = _measure(validation_y, predictions)
        result = {
            "schemaVersion": SCHEMA_VERSION,
            "experimentId": experiment_id,
            "repeat": fold.repeat,
            "fold": fold.fold,
            "seed": fold.seed,
            "trainRows": len(fold.train),
            "validationRows": len(fold.validation),
            "durationSeconds": time.monotonic() - fold_started,
            "seededParameters": seeded_parameters,
            "metrics": measurement,
        }
        with result_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        completed.append(result)
        for offset, index in enumerate(fold.validation):
            oof_rows.append({
                "id": str(frame.iloc[index]["id"]),
                "repeat": fold.repeat,
                "fold": fold.fold,
                "prediction": predictions[offset],
                "score": "" if scores is None else scores[offset],
            })
        _write_oof(output_dir / "oof_predictions.csv", oof_rows)
        events.emit("fold_completed", repeat=fold.repeat, fold=fold.fold, metrics=measurement, durationSeconds=result["durationSeconds"])

    interrupted = _stop_requested
    complete = len(completed) == len(folds) and not interrupted
    promotion_eligible = scope["kind"] == "promotion" and complete
    aggregate = None
    if oof_rows:
        labels_by_id = {str(frame.iloc[index]["id"]): int(y[index]) for index in range(len(frame))}
        aggregate = _measure(
            [labels_by_id[row["id"]] for row in oof_rows],
            [int(row["prediction"]) for row in oof_rows],
        )
    status = "interrupted" if interrupted else ("completed" if complete else "partial")
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": experiment_id,
        "status": status,
        "scope": scope["kind"],
        "promotionEligible": promotion_eligible,
        "requestedFolds": len(folds),
        "completedFolds": len(completed),
        "rows": len(frame),
        "manifestSha256": manifest["sha256"],
        "durationSeconds": time.monotonic() - started,
        "metrics": aggregate,
    }
    _atomic_json(output_dir / "metrics.json", summary)
    _atomic_json(output_dir / "trial-result.json", summary)
    events.emit("trial_finished", status=status, promotionEligible=promotion_eligible, completedFolds=len(completed), requestedFolds=len(folds), metrics=aggregate)
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
    parser.add_argument("--invocation", required=True, type=Path)
    arguments = parser.parse_args(argv)
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
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
