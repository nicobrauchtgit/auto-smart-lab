"""Harness-owned hyperparameter search.

Optuna proposes configurations through ``ask()``/``tell()``; it never owns
folds, fits, metrics, or cancellation. Every configuration is evaluated on the
one fold manifest already materialized for the trial, so all comparisons inside
a search are paired. The sampler seed and each configuration's estimator seeds
derive from the trial coordinate in the seed plan: the same request on the same
data proposes the same configurations.
"""
from __future__ import annotations

import itertools
import json
import math
import os
import random
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

from .recovery import save_checkpoint, load_checkpoint, digest
from .artifacts import EventWriter, _atomic_json, _write_oof
from .folds import ConcreteFold
from .invocation import Invocation, SearchSpec
from .metrics import _measure
from .measurement import primary_score, kind as measurement_kind
from .seeds import _derive_seed

FACTORY_PREFIX = "factory."


def selection_score(fold: dict[str, Any]) -> float:
    return float(fold["searchScore"]) if "searchScore" in fold else primary_score(fold["metrics"])


def _optuna() -> Any:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    return optuna


def sampler_seed(trial_seed: int) -> int:
    return _derive_seed("search_sampler", [trial_seed])


def _distribution(spec: dict[str, Any]) -> Any:
    optuna = _optuna()
    if spec["type"] == "int":
        return optuna.distributions.IntDistribution(int(spec["low"]), int(spec["high"]), log=bool(spec.get("log", False)),
                                                    step=int(spec.get("step", 1)))
    if spec["type"] == "float":
        return optuna.distributions.FloatDistribution(float(spec["low"]), float(spec["high"]), log=bool(spec.get("log", False)))
    return optuna.distributions.CategoricalDistribution(list(spec["choices"]))


def _grid_values(spec: dict[str, Any]) -> list[Any]:
    if spec["type"] == "categorical":
        return list(spec["choices"])
    if spec["type"] == "int":
        return list(range(int(spec["low"]), int(spec["high"]) + 1, int(spec.get("step", 1))))
    raise ValueError("grid search needs int or categorical parameters")


def planned_grid(search: SearchSpec, seed: int) -> list[dict[str, Any]]:
    """The whole grid in a seeded order, truncated to maxConfigs when smaller."""
    names = sorted(search.space)
    grid = [dict(zip(names, values)) for values in itertools.product(*(_grid_values(search.space[name]) for name in names))]
    random.Random(seed).shuffle(grid)
    return grid if search.max_configs is None else grid[:search.max_configs]


def _split(params: dict[str, Any], fixed: Any) -> tuple[Any, dict[str, Any]]:
    factory = {name[len(FACTORY_PREFIX):]: value for name, value in params.items() if name.startswith(FACTORY_PREFIX)}
    plain = {name: value for name, value in params.items() if not name.startswith(FACTORY_PREFIX)}
    if factory:
        base = fixed if isinstance(fixed, dict) else {}
        return {**base, **factory}, plain
    return fixed, plain


@dataclass
class ConfigResult:
    index: int
    config_id: str
    trial_number: int
    params: dict[str, Any]
    status: str = "running"
    reason: str | None = None
    folds: list[dict[str, Any]] = field(default_factory=list)
    oof: list[dict[str, Any]] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)
    seconds: float = 0.0

    @property
    def scores(self) -> list[float]:
        return [selection_score(fold) for fold in self.folds]

    @property
    def mean(self) -> float | None:
        return statistics.fmean(self.scores) if self.scores else None

    @property
    def std(self) -> float | None:
        return statistics.pstdev(self.scores) if len(self.scores) > 1 else (0.0 if self.scores else None)

    @property
    def fit_seconds(self) -> float:
        return sum(fold.get("fitSeconds", fold["durationSeconds"]) for fold in self.folds)

    def record(self, source: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "configId": self.config_id,
            "trialNumber": self.trial_number,
            "params": self.params,
            "status": self.status,
            **({"reason": self.reason} if self.reason else {}),
            "foldScores": [{"repeat": fold["repeat"], "fold": fold["fold"], **fold["metrics"],
                            **({"searchScore": fold["searchScore"], "objective": fold["searchObjective"]} if "searchScore" in fold else {}),
                            "fitSeconds": fold.get("fitSeconds", fold["durationSeconds"])} for fold in self.folds],
            "foldResults": self.folds,
            "meanScore": self.mean,
            "stdScore": self.std,
            "fitSeconds": self.fit_seconds,
            "seconds": self.seconds,
            "convergence": [fold.get("convergence") for fold in self.folds],
            **({"commit": source.get("commit"), "branch": source.get("branch")} if source else {}),
        }


class RuntimeGuard:
    """Projects search cost from measured fit times and stops gracefully when it is unacknowledged."""

    def __init__(self, invocation: Invocation, configs: int, folds: Sequence[ConcreteFold], started: float) -> None:
        self.spec = invocation.runtime
        self.accept = invocation.search.accept_seconds if invocation.search else None
        acknowledgement = invocation.output_dir / "resume-acknowledgement.json"
        if acknowledgement.exists():
            acceptance = json.loads(acknowledgement.read_text())["acceptEstimatedSeconds"]
            if not isinstance(acceptance, (float, int)) or not math.isfinite(acceptance) or acceptance <= 0:
                raise ValueError("Corrupt resume acknowledgement; supply a positive finite cost acceptance")
            self.accept = acceptance
        self.configs = configs
        self.folds = len(folds)
        self.started = started
        self.fits: list[float] = []
        batch = invocation.measurement is not None and invocation.measurement["execution"] == "batch"
        fit_rows = statistics.fmean([len(fold.validation if batch else fold.train) for fold in folds]) if folds else 0
        self.prior: float | None = None
        if self.spec.prior_fit_seconds is not None:
            # Fit time is assumed to scale linearly with the actually fitted rows.
            scale = fit_rows / self.spec.prior_train_rows if self.spec.prior_train_rows else 1.0
            self.prior = self.spec.prior_fit_seconds * scale
        self.accepted: float | None = None

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def per_fit(self) -> tuple[float | None, str]:
        if self.fits:
            return statistics.fmean(self.fits), "search"
        if self.prior is not None:
            return self.prior, f"pilot:{self.spec.prior_source}"
        return None, "unmeasured"

    def projection(self) -> float | None:
        per_fit, _ = self.per_fit()
        if per_fit is None:
            return None
        remaining = max(0, self.configs * self.folds - len(self.fits))
        return self.elapsed() + remaining * per_fit

    def hard_cap_reached(self) -> bool:
        return self.spec.max_seconds is not None and self.elapsed() >= self.spec.max_seconds

    def check_after_config(self, completed_configs: int) -> str | None:
        projection = self.projection()
        threshold = self.spec.confirm_above_seconds
        if projection is None:
            return None
        if completed_configs == 1:
            if threshold is not None and projection > threshold and (self.accept is None or projection > self.accept):
                return "acknowledgement_required"
            self.accepted = max(value for value in (threshold, self.accept, 0.0) if value is not None) or None
            return None
        if self.accepted is not None and projection > self.accepted * self.spec.overrun_factor:
            return "overrun"
        return None

    def explain(self, reason: str, results: Sequence[ConfigResult]) -> dict[str, Any]:
        projection = self.projection() or 0.0
        per_fit, source = self.per_fit()
        per_config = (per_fit or 0.0) * self.folds
        limit = {
            "acknowledgement_required": self.spec.confirm_above_seconds,
            "overrun": (self.accepted or 0.0) * self.spec.overrun_factor,
            "max_seconds": self.spec.max_seconds,
        }.get(reason)
        facts: dict[str, Any] = {
            "reason": reason,
            "projectedSeconds": math.ceil(projection),
            "elapsedSeconds": round(self.elapsed(), 1),
            "thresholdSeconds": self.spec.confirm_above_seconds,
            "acceptedSeconds": self.accepted if self.accepted is not None else self.accept,
            "overrunFactor": self.spec.overrun_factor,
            "maxSeconds": self.spec.max_seconds,
            "basis": {
                "secondsPerFit": None if per_fit is None else round(per_fit, 3),
                "source": source,
                "foldsPerConfiguration": self.folds,
                "configurationsPlanned": self.configs,
                "fitsCompleted": len(self.fits),
                "formula": "elapsed + remaining configurations x folds x seconds per fit",
            },
            "configurationsCompleted": sum(1 for result in results if result.status in {"completed", "pruned"}),
            "drivers": fit_time_drivers(results),
        }
        if per_config > 0 and limit:
            facts["maxConfigsWithinLimit"] = max(1, int(limit // per_config))
        if reason != "max_seconds":
            facts["acknowledge"] = {"search.acceptEstimatedSeconds": int(math.ceil(projection))}
        if self.spec.guidance:
            facts["guidance"] = self.spec.guidance
        return facts


def _groups(results: Sequence[ConfigResult], name: str) -> list[dict[str, Any]]:
    """Mean score and fit time per value, or per range for many distinct numbers."""
    rows = [(result.params.get(name), result) for result in results if name in result.params and result.mean is not None]
    if not rows:
        return []
    numeric = all(isinstance(value, (int, float)) and not isinstance(value, bool) for value, _ in rows)
    distinct = sorted({json.dumps(value) for value, _ in rows})
    buckets: list[tuple[str, list[ConfigResult], Any, Any]] = []
    if numeric and len(distinct) > 4:
        ordered = sorted(rows, key=lambda row: row[0])
        size = math.ceil(len(ordered) / 3)
        for start in range(0, len(ordered), size):
            chunk = ordered[start:start + size]
            low, high = chunk[0][0], chunk[-1][0]
            buckets.append((f"{low:g}..{high:g}", [result for _, result in chunk], low, high))
    else:
        for key in distinct:
            value = json.loads(key)
            members = [result for candidate, result in rows if json.dumps(candidate) == key]
            buckets.append((json.dumps(value), members, value, value))
    groups = []
    for label, members, low, high in buckets:
        groups.append({
            "values": label, "low": low, "high": high, "configs": len(members),
            "meanScore": statistics.fmean(member.mean for member in members),
            "meanFitSeconds": statistics.fmean(member.fit_seconds / max(1, len(member.folds)) for member in members),
        })
    return groups


def fit_time_drivers(results: Sequence[ConfigResult]) -> list[dict[str, Any]]:
    names = sorted({name for result in results for name in result.params})
    drivers = []
    for name in names:
        groups = _groups(results, name)
        if len(groups) < 2:
            continue
        fastest = min(groups, key=lambda group: group["meanFitSeconds"])
        slowest = max(groups, key=lambda group: group["meanFitSeconds"])
        ratio = slowest["meanFitSeconds"] / fastest["meanFitSeconds"] if fastest["meanFitSeconds"] > 0 else None
        drivers.append({"parameter": name, "slowestValues": slowest["values"], "fastestValues": fastest["values"],
                        "fitTimeRatio": None if ratio is None else round(ratio, 2)})
    return sorted(drivers, key=lambda entry: -(entry["fitTimeRatio"] or 0))


def _paired(left: ConfigResult | dict[str, Any], right_scores: dict[tuple[int, int], float],
            left_scores: dict[tuple[int, int], float] | None = None) -> dict[str, Any]:
    """Per-fold differences on identical folds and whether the lead exceeds fold noise."""
    left_scores = left_scores if left_scores is not None else {
        (fold["repeat"], fold["fold"]): selection_score(fold) for fold in left.folds}  # type: ignore[union-attr]
    keys = sorted(set(left_scores) & set(right_scores))
    differences = [left_scores[key] - right_scores[key] for key in keys]
    if not differences:
        return {"folds": 0}
    mean = statistics.fmean(differences)
    spread = statistics.stdev(differences) if len(differences) > 1 else 0.0
    error = spread / math.sqrt(len(differences)) if len(differences) > 1 else None
    from .uncertainty import corrected_cv
    left_folds = left.folds if isinstance(left, ConfigResult) else left.get("folds", [])
    indexed = {(fold["repeat"], fold["fold"]): fold for fold in left_folds}
    return {
        "folds": len(differences),
        "perFold": [{"repeat": key[0], "fold": key[1], "difference": difference} for key, difference in zip(keys, differences)],
        "meanDifference": mean,
        "foldsFavoringFirst": sum(1 for value in differences if value > 0),
        "foldsFavoringSecond": sum(1 for value in differences if value < 0),
        "ties": sum(1 for value in differences if value == 0),
        "standardError": error,
        "approximateInterval95": [mean - 1.96 * error, mean + 1.96 * error] if error is not None else None,
        "intervalAssumesIndependentFoldDifferences": True,
        "correctedCvUncertainty": corrected_cv(differences, [indexed[key] for key in keys if key in indexed]),
        "leadExceedsNoise": bool(error is not None and abs(mean) > 2 * error and mean != 0),
        "noiseRule": "|mean difference| > 2 x standard error of the per-fold differences (folds share training rows, so this is approximate)",
    }


def fold_scores(folds: Sequence[dict[str, Any]], selection: bool = False) -> dict[tuple[int, int], float]:
    score = selection_score if selection else lambda fold: primary_score(fold["metrics"])
    return {(fold["repeat"], fold["fold"]): score(fold) for fold in folds}


def confirmation_request(invocation: Invocation, best: ConfigResult) -> dict[str, Any]:
    """The exact fixed-parameter request that confirms the winner on a fresh manifest."""
    factory_parameters, plain = _split(best.params, invocation.pipeline.parameters)
    pipeline: dict[str, Any] = {"module": invocation.pipeline.module, "factory": invocation.pipeline.factory}
    if factory_parameters is not None and factory_parameters != {} or "parameters" in invocation.request.get("pipeline", {}):
        pipeline["parameters"] = factory_parameters
    estimator_params = {**invocation.pipeline.estimator_params, **plain}
    if estimator_params:
        pipeline["estimatorParams"] = estimator_params
    request: dict[str, Any] = {
        "schemaVersion": 2,
        "hypothesis": f"Confirm search {invocation.experiment_id} winner {best.config_id} on fresh folds: {invocation.hypothesis}"[:2_000],
        "pipeline": pipeline,
        "cv": invocation.request.get("cv"),
        "scope": {"kind": "promotion"},
    }
    if invocation.source and invocation.source.get("commit"):
        request["commit"] = invocation.source["commit"]
    if "diagnostics" in invocation.request:
        request["diagnostics"] = invocation.request["diagnostics"]
    return request


class KernelJournalLock:
    """A dead writer releases flock in the kernel; no stale symlink lease."""
    def __init__(self, path):
        self.path = path
        self.file = None

    def acquire(self):
        import fcntl
        self.file = self.path.open("a")
        for _ in range(200):
            try:
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                time.sleep(0.025)
        self.file.close()
        self.file = None
        raise ValueError("Journal writer lock remained busy for 5 seconds; inspect owned worker group before retrying")

    def release(self):
        if self.file is not None:
            self.file.close()
            self.file = None


def run_search(invocation: Invocation, events: EventWriter, output_dir: Path, pipeline_factory: Any,
               folds: Sequence[ConcreteFold], frame: Any, y: Sequence[int], ids: Sequence[str],
               stop_requested: Callable[[], bool], run_fold: Callable[..., tuple[dict[str, Any], list[dict[str, Any]]]]) -> dict[str, Any]:
    optuna = _optuna()
    search = invocation.search
    assert search is not None
    seed = sampler_seed(invocation.trial_seed)
    distributions = {name: _distribution(spec) for name, spec in search.space.items()}
    grid = planned_grid(search, seed) if search.sampler == "grid" else None
    planned = len(grid) if grid is not None else int(search.max_configs or 0)
    sampler = optuna.samplers.TPESampler(seed=seed) if search.sampler == "tpe" else optuna.samplers.RandomSampler(seed=seed)
    pruner = (optuna.pruners.MedianPruner(n_startup_trials=3, n_warmup_steps=1) if search.pruning
              else optuna.pruners.NopPruner())
    journal = output_dir / "study.journal"
    if journal.exists():
        for number, line in enumerate(journal.read_text().splitlines(), 1):
            try:
                record = json.loads(line)
                if not isinstance(record, dict) or "op_code" not in record:
                    raise ValueError("missing operation")
            except ValueError as error:
                raise ValueError(f"Corrupt study.journal at line {number}; restore the original journal before resuming; no fit started") from error
    storage = optuna.storages.JournalStorage(optuna.storages.journal.JournalFileBackend(str(output_dir / "study.journal"), lock_obj=KernelJournalLock(output_dir / "study.journal.flock")))
    study = optuna.create_study(study_name=invocation.experiment_id, storage=storage, sampler=sampler, pruner=pruner,
                                direction="maximize", load_if_exists=True)
    if not study.trials:
        for params in grid or []:
            study.enqueue_trial(params)

    started = time.monotonic()
    guard = RuntimeGuard(invocation, planned, folds, started)
    events.emit("search_started", sampler=search.sampler, samplerSeed=seed, configsPlanned=planned,
                folds=len(folds), pruning=search.pruning, space=search.space,
                projectedSeconds=guard.projection(), projectionSource=guard.per_fit()[1])
    configs_path = output_dir / "configs.jsonl"
    results: list[ConfigResult] = []
    stop_reason: str | None = None
    guard_stop: dict[str, Any] | None = None
    best: ConfigResult | None = None
    runner_up: ConfigResult | None = None
    progress: list[dict[str, Any]] = []

    # JournalStorage persists observations, but not sampler RNG state or OOF
    # rows. Replay ask/tell into a private study to restore the seeded sampler,
    # then continue the durable study without refitting completed configs.
    checkpoint = output_dir / "search-checkpoint.json"
    previous = load_checkpoint(checkpoint) if checkpoint.exists() else {"results": []}
    identity = digest({"experimentId": invocation.experiment_id, "trialSeed": invocation.trial_seed,
                       "pipeline": invocation.request.get("pipeline"), "cv": invocation.request.get("cv"),
                       "scope": invocation.request.get("scope"), "space": search.space, "sampler": search.sampler,
                       "maxConfigs": search.max_configs, "pruning": search.pruning})
    if checkpoint.exists() and previous.get("searchIdentity") != identity:
        raise ValueError("Search checkpoint request identity differs; restore original invocation")
    runtime_path = output_dir / "recovery-runtime.json"
    runtime_floor = json.loads(runtime_path.read_text())["consumedSeconds"] if runtime_path.exists() else 0
    if not isinstance(runtime_floor, (int, float)) or not math.isfinite(runtime_floor) or runtime_floor < 0:
        raise ValueError("Corrupt cumulative runtime accounting; restore recovery-runtime.json")
    guard.started -= max(previous.get("elapsedSeconds", 0.0), runtime_floor)
    if previous.get("trialSeed", invocation.trial_seed) != invocation.trial_seed:
        raise ValueError("search checkpoint belongs to a different seed coordinate")
    if not isinstance(previous.get("elapsedSeconds", 0), (int, float)) or not math.isfinite(previous.get("elapsedSeconds", 0)) or previous.get("elapsedSeconds", 0) < 0:
        raise ValueError("Invalid elapsedSeconds in search checkpoint")
    if not isinstance(previous["results"], list) or len(previous["results"]) > planned:
        raise ValueError("Invalid completed configuration count in search checkpoint")
    by_number = {row["trial_number"]: row for row in previous["results"]}
    if len(by_number) != len(previous["results"]):
        raise ValueError("Duplicate configuration numbers in checkpoint")
    recorded = [trial for trial in study.trials if trial.state != optuna.trial.TrialState.WAITING]
    if len(recorded) > planned or any(n not in {t.number for t in recorded} for n in by_number):
        raise ValueError("Search journal/checkpoint configuration counts differ; restore original artifacts")
    for frozen in recorded:
        row = by_number.get(frozen.number)
        if frozen.state == optuna.trial.TrialState.COMPLETE and row is None:
            raise ValueError("Completed journal configuration lacks authoritative prediction checkpoint; restore checkpoint before resuming")
        if row and (row['params'] != frozen.params or row['index'] != recorded.index(frozen)):
            raise ValueError("Configuration checkpoint differs from journal; restore original checkpoint")
    if recorded:
        replay = optuna.create_study(sampler=sampler, pruner=pruner, direction="maximize")
        for params in grid or []:
            replay.enqueue_trial(params)
        for frozen in recorded:
            proposed = replay.ask(distributions)
            if proposed.params != frozen.params:
                raise ValueError("journal sampling replay differs from recorded configuration")
            for step, value in sorted(frozen.intermediate_values.items()):
                proposed.report(value, step)
            for name, value in frozen.user_attrs.items():
                proposed.set_user_attr(name, value)
            state = frozen.state
            if state == optuna.trial.TrialState.RUNNING:
                # A process lost during a fit has no authoritative complete
                # result. Preserve it as failed, rather than silently refit it.
                study.tell(frozen.number, state=optuna.trial.TrialState.FAIL)
                state = optuna.trial.TrialState.FAIL
            replay.tell(proposed, frozen.value if state == optuna.trial.TrialState.COMPLETE else None, state=state)
            row = by_number.get(frozen.number)
            if row:
                result = ConfigResult(**row)
            else:
                result = ConfigResult(len(results), f"c{len(results):03d}", frozen.number, dict(frozen.params),
                                      status="failed", reason="process interrupted before authoritative configuration checkpoint")
            results.append(result)
            guard.fits.extend(fold.get("fitSeconds", fold["durationSeconds"]) for fold in result.folds)
        completed = sorted((result for result in results if result.status == "completed"), key=lambda row: -row.mean)
        best = completed[0] if completed else None
        runner_up = completed[1] if len(completed) > 1 else None
        progress = previous.get("progress", [])
        # Recheck the original cost controls before fitting anything else.
        guard.accepted = max(value for value in (guard.spec.confirm_above_seconds, guard.accept, 0.0) if value is not None) or None
        verdict = guard.check_after_config(len(results))
        if verdict:
            stop_reason = verdict
            guard_stop = guard.explain(verdict, results)
        events.emit("search_resumed", configurationsRetained=len(results), configsPlanned=planned)
        # Reconcile a lost append after a durable journal write/checkpoint.
        configs_path.write_text("".join(json.dumps(_jsonable(row.record(invocation.source)), sort_keys=True, allow_nan=False) + "\n"
                                        for row in results), encoding="utf-8")

    for index in range(len(results), planned):
        if stop_reason:
            break
        if stop_requested():
            stop_reason = "stop_requested"
            break
        if guard.hard_cap_reached():
            stop_reason = "max_seconds"
            guard_stop = guard.explain("max_seconds", results)
            break
        trial = study.ask(distributions)
        result = ConfigResult(index, f"c{index:03d}", trial.number, dict(trial.params))
        factory_parameters, plain = _split(result.params, invocation.pipeline.parameters)
        events.emit("config_started", configId=result.config_id, trialNumber=trial.number, params=result.params)
        try:
            for step, fold in enumerate(folds):
                if stop_requested():
                    result.status, result.reason = "stopped", "stop requested"
                    break
                if guard.hard_cap_reached():
                    result.status, result.reason = "stopped", "search.maxSeconds reached"
                    break
                fold_result, rows = run_fold(invocation, pipeline_factory, fold, frame, y, ids,
                                             factory_parameters=factory_parameters, estimator_params=plain,
                                             estimator_index=index, config_id=result.config_id, convergence=True)
                result.folds.append(fold_result)
                result.oof.extend(rows)
                measured_fit = fold_result.get("fitSeconds", fold_result["durationSeconds"])
                guard.fits.append(measured_fit)
                score = selection_score(fold_result)
                events.emit("fold_completed", configId=result.config_id, params=result.params, repeat=fold.repeat,
                            fold=fold.fold, metrics=fold_result["metrics"], fitSeconds=measured_fit,
                            convergence=fold_result.get("convergence"))
                trial.report(statistics.fmean(result.scores), step)
                if search.pruning and step < len(folds) - 1 and trial.should_prune():
                    result.status = "pruned"
                    result.reason = (f"median pruner: after {step + 1} fold(s) the running mean "
                                     f"{statistics.fmean(result.scores):.4f} was below the median of earlier configurations at the same fold")
                    break
            else:
                result.status = "completed"
        except Exception as error:  # one invalid configuration does not end the search
            result.status, result.reason = "failed", f"{type(error).__name__}: {error}"[:1_000]
        result.seconds = time.monotonic() - result.started
        trial.set_user_attr("fitSeconds", result.fit_seconds)
        trial.set_user_attr("configId", result.config_id)
        if result.status == "completed":
            study.tell(trial, result.mean)
        elif result.status == "pruned":
            study.tell(trial, state=optuna.trial.TrialState.PRUNED)
        else:
            study.tell(trial, state=optuna.trial.TrialState.FAIL)
        results.append(result)
        with configs_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(_jsonable(result.record(invocation.source)), sort_keys=True, allow_nan=False) + "\n")
        if result.status == "completed":
            if best is None or result.mean > best.mean:
                best, runner_up = result, best
            elif runner_up is None or result.mean > runner_up.mean:
                runner_up = result
            # Row-level predictions are kept only for the top two.
            for other in results:
                if other is not best and other is not runner_up:
                    other.oof = []
        else:
            result.oof = []
        progress.append({"configs": index + 1, "bestMean": None if best is None else best.mean,
                         "bestConfigId": None if best is None else best.config_id})
        save_checkpoint(checkpoint, {"trialSeed": invocation.trial_seed, "searchIdentity": identity,
                                 "results": [dataclass_record(row) for row in results], "progress": progress,
                                 "elapsedSeconds": guard.elapsed()})
        events.emit(f"config_{result.status}", configId=result.config_id, params=result.params, status=result.status,
                    reason=result.reason, meanScore=result.mean, stdScore=result.std, folds=len(result.folds),
                    fitSeconds=result.fit_seconds)
        projection = guard.projection()
        events.emit("search_progress", completed=len(results), planned=planned,
                    best=None if best is None else {"configId": best.config_id, "meanScore": best.mean, "params": best.params},
                    projectedTotalSeconds=projection,
                    projectedRemainingSeconds=None if projection is None else max(0.0, projection - guard.elapsed()))
        if result.status == "stopped":
            stop_reason = "stop_requested" if result.reason == "stop requested" else "max_seconds"
            if stop_reason == "max_seconds":
                guard_stop = guard.explain("max_seconds", results)
            break
        verdict = guard.check_after_config(len(results)) if index + 1 < planned else None
        if verdict:
            stop_reason = verdict
            guard_stop = guard.explain(verdict, results)
            events.emit("search_guard_stopped", **guard_stop)
            break

    return {
        "results": results, "best": best, "runnerUp": runner_up, "planned": planned, "stopReason": stop_reason,
        "guard": guard_stop, "progress": progress, "seconds": guard.elapsed(), "study": study,
        "samplerSeed": seed,
    }


def dataclass_record(result: ConfigResult) -> dict[str, Any]:
    import dataclasses
    return _jsonable(dataclasses.asdict(result))


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(entry) for key, entry in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(entry) for entry in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        import numpy as np
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            return float(value)
    except ImportError:
        pass
    return value


def _importance(study: Any, seed: int, target: Callable[[Any], float] | None = None) -> dict[str, Any]:
    optuna = _optuna()
    completed = [trial for trial in study.trials if trial.state == optuna.trial.TrialState.COMPLETE]
    if len(completed) < 2:
        return {"available": False, "reason": f"{len(completed)} completed configuration(s); at least 2 are needed",
                "completedConfigs": len(completed)}
    try:
        evaluator = optuna.importance.FanovaImportanceEvaluator(seed=seed)
        values = optuna.importance.get_param_importances(study, evaluator=evaluator, target=target)
    except Exception as error:
        return {"available": False, "reason": f"{type(error).__name__}: {error}"[:500], "completedConfigs": len(completed)}
    return {"available": True, "method": "fANOVA (Optuna)", "completedConfigs": len(completed),
            "importances": {name: float(value) for name, value in values.items()}}


def write_search_outputs(invocation: Invocation, output_dir: Path, outcome: dict[str, Any], manifest: dict[str, Any],
                         labels_by_id: dict[str, int], champion: dict[str, Any] | None) -> dict[str, Any]:
    """Authoritative artifacts for the best configuration and the explanatory report."""
    results: list[ConfigResult] = outcome["results"]
    best: ConfigResult | None = outcome["best"]
    runner_up: ConfigResult | None = outcome["runnerUp"]
    if best is not None:
        fold_path = output_dir / "fold-results.jsonl"
        with fold_path.open("w", encoding="utf-8") as stream:
            for fold in best.folds:
                stream.write(json.dumps(_jsonable(fold), sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
        _write_oof(output_dir / "oof_predictions.csv", best.oof)
    if runner_up is not None:
        _write_oof(output_dir / "oof_runner_up.csv", runner_up.oof)

    seed = outcome["samplerSeed"]
    completed = [result for result in results if result.status == "completed"]
    leaderboard = sorted(results, key=lambda result: (result.status != "completed", -(result.mean if result.mean is not None else -1.0), result.index))
    effects = {name: _groups(results, name) for name in invocation.search.space} if invocation.search else {}
    effect_lines = []
    for name, groups in effects.items():
        if len(groups) < 2:
            continue
        top = max(groups, key=lambda group: group["meanScore"])
        low = min(groups, key=lambda group: group["meanScore"])
        fastest = min(groups, key=lambda group: group["meanFitSeconds"])
        slowest = max(groups, key=lambda group: group["meanFitSeconds"])
        ratio = slowest["meanFitSeconds"] / fastest["meanFitSeconds"] if fastest["meanFitSeconds"] > 0 else float("nan")
        effect_lines.append(
            f"{name} {top['values']}: mean score {top['meanScore']:.4f} vs {low['meanScore']:.4f} at {low['values']} "
            f"(difference {top['meanScore'] - low['meanScore']:+.4f}); fit time {ratio:.1f}x at {slowest['values']} "
            f"vs {fastest['values']}")
    best_by_count = outcome["progress"]
    last_improvement = 0
    for index, entry in enumerate(best_by_count):
        if index == 0 or (entry["bestMean"] is not None and entry["bestMean"] != best_by_count[index - 1]["bestMean"]):
            last_improvement = index + 1
    evaluated = len(results)
    fit_times = [fold.get("fitSeconds", fold["durationSeconds"]) for result in results for fold in result.folds]
    comparison: dict[str, Any] = {}
    if best is not None and runner_up is not None:
        comparison["bestVersusRunnerUp"] = {"best": best.config_id, "runnerUp": runner_up.config_id,
                                            "proxyEvidence": invocation.search.objective is not None,
                                            **_paired(best, fold_scores(runner_up.folds, selection=True))}
    else:
        comparison["bestVersusRunnerUp"] = {"available": False, "reason": "fewer than two completed configurations"}
    if champion and best is not None and champion.get("folds"):
        comparison["bestVersusChampion"] = {"best": best.config_id, "champion": champion.get("experimentId"),
                                            "championCommit": champion.get("commit"),
                                            **_paired(best, fold_scores(champion["folds"]))}
    else:
        comparison["bestVersusChampion"] = {"available": False,
                                            "reason": (champion or {}).get("reason", "no champion exists yet")}
    report = {
        "schemaVersion": 1,
        "experimentId": invocation.experiment_id,
        "identity": {key: os.environ[variable] for key, variable in (("pipelineRunId", "PIPELINE_RUN_ID"),
                                                                       ("stageInvocationId", "PIPELINE_STAGE_INVOCATION_ID"))
                     if os.environ.get(variable)},
        "source": invocation.source,
        "manifestSha256": manifest["sha256"],
        "objective": invocation.search.objective or {"kind": "controller_primary_metric"},
        "proxyEvidence": invocation.search.objective is not None,
        "sampler": {"name": invocation.search.sampler, "seed": seed, "pruning": invocation.search.pruning},
        "configs": {"planned": outcome["planned"], "evaluated": evaluated, "completed": len(completed),
                    "pruned": sum(1 for result in results if result.status == "pruned"),
                    "failed": sum(1 for result in results if result.status == "failed"),
                    "stopped": sum(1 for result in results if result.status == "stopped")},
        "stopReason": outcome["stopReason"],
        "leaderboard": [{"rank": rank + 1, **_jsonable(result.record(invocation.source))} for rank, result in enumerate(leaderboard)],
        "parameterImportance": _importance(outcome["study"], seed),
        "parameterEffects": {"byParameter": effects, "summary": effect_lines},
        "comparison": comparison,
        "progress": {
            "bestByConfigCount": best_by_count,
            "summary": {
                "configsEvaluated": evaluated,
                "lastImprovementAtConfig": last_improvement,
                "improvedInFinalThird": bool(evaluated and last_improvement > evaluated * 2 / 3),
            },
        },
        "cost": {
            "totalSeconds": outcome["seconds"],
            "fits": len(fit_times),
            "secondsPerFitMean": statistics.fmean(fit_times) if fit_times else None,
            "secondsPerFitMedian": statistics.median(fit_times) if fit_times else None,
            "fitTimeDrivers": fit_time_drivers(results),
            "fitTimeImportance": _importance(outcome["study"], seed, target=lambda trial: trial.user_attrs.get("fitSeconds", 0.0)),
        },
        "caveats": list(invocation.caveats) + ([f"Only {len(completed)} configuration(s) completed."] if len(completed) < 10 else []),
        "nextStep": {"confirmationRequest": confirmation_request(invocation, best)} if best is not None else {
            "confirmationRequest": None},
        **({"runtimeGuard": outcome["guard"]} if outcome["guard"] else {}),
    }
    _atomic_json(output_dir / "search-report.json", _jsonable(report))
    aggregate = None
    if best is not None and measurement_kind(invocation) == "classification":
        aggregate = _measure([labels_by_id[row["id"]] for row in best.oof], [int(row["prediction"]) for row in best.oof])
    elif best is not None and measurement_kind(invocation) == "clustering" and "adjustedRandIndex" in best.folds[0]["metrics"]:
        aggregate = {"adjustedRandIndex": statistics.fmean(primary_score(fold["metrics"]) for fold in best.folds)}
    elif best is not None and measurement_kind(invocation) == "anomaly_detection" and (invocation.measurement or {}).get("selection"):
        aggregate = {"selectionScore": statistics.fmean(primary_score(fold["metrics"]) for fold in best.folds)}
    return {"report": report, "metrics": aggregate}
