"""Typed worker invocation contract."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .seeds import _derive_seed

SCHEMA_VERSION = 1
#: Invocation and request versions this worker executes. Version 2 adds the
#: trial's source worktree, fixed estimator parameters, search, runtime guard,
#: and champion comparison; artifacts keep SCHEMA_VERSION.
SUPPORTED_VERSIONS = (1, 2)
SAMPLERS = ("tpe", "random", "grid")


class InvocationError(ValueError):
    """The invocation or agent-provided factory violates the worker contract."""


@dataclass(frozen=True)
class CvSpec:
    kind: str
    repeats: int
    folds: int | None
    module: str | None
    factory: str | None
    options: Any


@dataclass(frozen=True)
class Scope:
    kind: str
    max_rows: int | None
    max_folds: int | None


@dataclass(frozen=True)
class PipelineSpec:
    module: str
    factory: str
    parameters: Any
    #: Applied through set_params after construction and seeding.
    estimator_params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchSpec:
    space: dict[str, dict[str, Any]]
    sampler: str
    max_configs: int | None
    pruning: bool
    accept_seconds: float | None


@dataclass(frozen=True)
class RuntimeGuard:
    confirm_above_seconds: float | None = None
    overrun_factor: float = 1.5
    max_seconds: float | None = None
    #: Measured seconds per fold fit from the most recent pilot of the same
    #: commit and pipeline, and the training rows it was measured on.
    prior_fit_seconds: float | None = None
    prior_train_rows: int | None = None
    prior_source: str | None = None
    #: Prompt-registry prose on reducing cost, attached to a guard stop verbatim.
    guidance: str | None = None


@dataclass(frozen=True)
class Invocation:
    experiment_id: str
    hypothesis: str
    pipeline: PipelineSpec
    cv: CvSpec
    scope: Scope
    project_root: Path
    zip_path: str
    labels_path: str
    output_dir: Path
    experiment_seed: int
    trial_seed: int
    #: Root containing the trial's `solutions` worktree; the project root for
    #: legacy, unversioned invocations.
    source_root: Path | None = None
    source: dict[str, Any] | None = None
    search: SearchSpec | None = None
    runtime: RuntimeGuard = field(default_factory=RuntimeGuard)
    #: Frozen champion to rerun on this trial's manifest, if any.
    champion: dict[str, Any] | None = None
    caveats: tuple[str, ...] = ()
    request: dict[str, Any] = field(default_factory=dict)

    @property
    def code_root(self) -> Path:
        return self.source_root or self.project_root


def _object(document: dict[str, Any], key: str) -> dict[str, Any]:
    value = document.get(key)
    if not isinstance(value, dict):
        raise InvocationError(f"{key} must be an object")
    return value


def parse_invocation(document: dict[str, Any]) -> Invocation:
    if document.get("schemaVersion") not in SUPPORTED_VERSIONS:
        raise InvocationError(f"schemaVersion must be one of {SUPPORTED_VERSIONS}")
    if not isinstance(document.get("experimentId"), str) or not document["experimentId"]:
        raise InvocationError("experimentId must be a non-empty string")
    request = _object(document, "request")
    if request.get("schemaVersion") not in SUPPORTED_VERSIONS:
        raise InvocationError(f"request.schemaVersion must be one of {SUPPORTED_VERSIONS}")
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
    repeats = cv.get("repeats", 1)
    if not isinstance(repeats, int) or repeats < 1:
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
    project_root = Path(inputs["projectRoot"]).resolve()
    if not project_root.is_dir():
        raise InvocationError("inputs.projectRoot must be an existing directory")
    source_root = None
    if inputs.get("sourceRoot") is not None:
        if not isinstance(inputs["sourceRoot"], str) or not Path(inputs["sourceRoot"]).is_dir():
            raise InvocationError("inputs.sourceRoot must be an existing directory")
        source_root = Path(inputs["sourceRoot"]).resolve()
    estimator_params = pipeline.get("estimatorParams", {})
    if not isinstance(estimator_params, dict):
        raise InvocationError("request.pipeline.estimatorParams must be an object")
    caveats = document.get("caveats", [])
    if not isinstance(caveats, list) or not all(isinstance(entry, str) for entry in caveats):
        raise InvocationError("caveats must be a list of strings")
    champion = document.get("champion")
    if champion is not None and not isinstance(champion, dict):
        raise InvocationError("champion must be an object")
    source = document.get("source")
    if source is not None and not isinstance(source, dict):
        raise InvocationError("source must be an object")
    return Invocation(
        experiment_id=document["experimentId"],
        hypothesis=request["hypothesis"],
        pipeline=PipelineSpec(pipeline["module"], pipeline["factory"], pipeline.get("parameters", {}), dict(estimator_params)),
        cv=CvSpec(cv["kind"], repeats, cv.get("folds"), cv.get("module"), cv.get("factory"), cv.get("options", {})),
        scope=Scope(scope["kind"], scope.get("maxRows"), scope.get("maxFolds")),
        project_root=project_root,
        zip_path=inputs["zipPath"],
        labels_path=inputs["labelsPath"],
        output_dir=Path(inputs["outputDir"]).resolve(),
        experiment_seed=seeds["experiment"],
        # Legacy invocations omit trial; service invocations persist it.
        trial_seed=seeds.get("trial", _derive_seed("trial", [seeds["experiment"], 0])),
        source_root=source_root,
        source=source,
        search=_parse_search(request.get("search")),
        runtime=_parse_runtime(document.get("runtime")),
        champion=champion,
        caveats=tuple(caveats),
        request=request,
    )


def _parse_search(raw: Any) -> SearchSpec | None:
    """Structure was validated by the harness; this guards the worker boundary."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("space"), dict) or not raw["space"]:
        raise InvocationError("request.search.space must be a non-empty object")
    sampler = raw.get("sampler", "tpe")
    if sampler not in SAMPLERS:
        raise InvocationError(f"request.search.sampler must be one of {SAMPLERS}")
    max_configs = raw.get("maxConfigs")
    if max_configs is not None and (not isinstance(max_configs, int) or max_configs < 1):
        raise InvocationError("request.search.maxConfigs must be a positive integer")
    if max_configs is None and sampler != "grid":
        raise InvocationError("request.search.maxConfigs is required for tpe and random")
    for name, distribution in raw["space"].items():
        if not isinstance(distribution, dict) or distribution.get("type") not in {"int", "float", "categorical"}:
            raise InvocationError(f"request.search.space.{name} has an invalid distribution")
    accept = raw.get("acceptEstimatedSeconds")
    if accept is not None and (not isinstance(accept, (int, float)) or accept <= 0):
        raise InvocationError("request.search.acceptEstimatedSeconds must be positive")
    return SearchSpec(dict(raw["space"]), sampler, max_configs, bool(raw.get("pruning", False)),
                      None if accept is None else float(accept))


def _parse_runtime(raw: Any) -> RuntimeGuard:
    if raw is None:
        return RuntimeGuard()
    if not isinstance(raw, dict):
        raise InvocationError("runtime must be an object")

    def number(key: str, minimum: float = 0.0) -> float | None:
        value = raw.get(key)
        if value is None:
            return None
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= minimum:
            raise InvocationError(f"runtime.{key} must be a number above {minimum}")
        return float(value)

    rows = raw.get("priorTrainRows")
    if rows is not None and (not isinstance(rows, int) or rows < 1):
        raise InvocationError("runtime.priorTrainRows must be a positive integer")
    source = raw.get("priorSource")
    return RuntimeGuard(
        confirm_above_seconds=number("confirmAboveSeconds"),
        overrun_factor=number("overrunFactor", 1.0) or 1.5,
        max_seconds=number("maxSeconds"),
        prior_fit_seconds=number("priorFitSeconds"),
        prior_train_rows=rows,
        prior_source=source if isinstance(source, str) else None,
        guidance=raw.get("guidance") if isinstance(raw.get("guidance"), str) else None,
    )
