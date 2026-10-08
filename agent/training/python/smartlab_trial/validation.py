"""Layer 2 request validation against the real pipeline, without fitting.

The harness runs this in a short, time-bounded process before a request counts
against the budget. It builds the agent's pipeline from the requested commit's
worktree and checks every parameter the request fixes or searches:

- plain names must exist in ``get_params(deep=True)``;
- ``factory.`` values must be accepted by the factory; and
- scikit-learn's own parameter constraints must accept the boundary values and
  every choice, checked with ``set_params`` and the owning estimator's
  ``_validate_params`` without calling ``fit``.

Every problem is reported together, in the same shape as the TypeScript
structural layer, with scikit-learn's message verbatim where it has one.
"""
from __future__ import annotations

import difflib
import math
import re
import traceback
from pathlib import Path
from typing import Any, Iterable

from .agent_code import _call_pipeline_factory, _load_module, expose_project

FACTORY_PREFIX = "factory."
_EXPECTED = re.compile(r"must be (?P<expected>.*?)\. Got (?P<received>.*) instead\.?\s*$", re.DOTALL)


def _issue(path: str, problem: str, received: Any, expected: str, hint: str, message: str | None = None) -> dict[str, Any]:
    issue = {"path": path, "problem": problem, "received": _jsonable(received), "expected": expected, "hint": hint}
    if message:
        issue["message"] = message
    return issue


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(entry) for entry in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(entry) for key, entry in value.items()}
    return repr(value)[:200]


def _last_line(error: BaseException) -> str:
    return "".join(traceback.format_exception_only(type(error), error)).strip()[-1_000:]


def _candidates(distribution: dict[str, Any]) -> list[tuple[str, Any]]:
    """Values to check: both bounds of a range and every categorical choice."""
    if distribution.get("type") == "categorical":
        return [(f".choices[{index}]", choice) for index, choice in enumerate(distribution.get("choices", []))]
    low, high = distribution["low"], distribution["high"]
    middle = math.exp((math.log(low) + math.log(high)) / 2) if distribution.get("log") else low / 2 + high / 2
    if distribution["type"] == "int":
        step = distribution.get("step", 1)
        middle = low + int((middle - low) // step) * step
    return [(".low", low), (".high", high)] + ([(".sample", middle)] if low < middle < high else [])


def _step_listing(name: str, names: Iterable[str]) -> str:
    names = sorted(names)
    if "__" in name:
        step = name.split("__", 1)[0]
        children = sorted({key.split("__", 1)[1] for key in names if key.startswith(f"{step}__") and key.count("__") == 1})
        if children:
            shown = ", ".join(children[:12]) + (", ..." if len(children) > 12 else "")
            return f"Parameters of step '{step}': {shown}"
    top = [key for key in names if "__" not in key]
    shown = ", ".join(top[:12]) + (", ..." if len(top) > 12 else "")
    return f"Top-level parameters: {shown}"


def _owner(estimator: Any, name: str) -> Any:
    owner_path, _, _leaf = name.rpartition("__")
    return estimator if not owner_path else estimator.get_params(deep=True).get(owner_path)


def _check_value(estimator: Any, name: str, value: Any, path: str) -> dict[str, Any] | None:
    """Set one value on a fresh clone and run the owner's own constraint check."""
    try:
        from sklearn.base import clone
        candidate = clone(estimator)
    except Exception:
        candidate = estimator
    try:
        candidate.set_params(**{name: value})
        owner = _owner(candidate, name)
        validate = getattr(owner, "_validate_params", None)
        if callable(validate) and hasattr(owner, "_parameter_constraints"):
            validate()
    except Exception as error:  # sklearn's InvalidParameterError is both ValueError and TypeError
        owner = _owner(candidate, name) if hasattr(candidate, "get_params") else candidate
        message = str(error)
        match = _EXPECTED.search(message)
        expected = match.group("expected") if match else "a value the estimator accepts"
        hint = (
            "Use a fraction such as 0.5, or an integer count."
            if "float in the range (0.0, 1.0]" in expected and isinstance(value, (int, float)) and not isinstance(value, bool)
            else "Choose values inside the expected set; adjust low/high or remove this choice."
        )
        return _issue(path, f"rejected by {type(owner).__name__}", value, expected, hint, message)
    return None


def validate_request(source_root: Path, request: dict[str, Any], measurement: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    expose_project(source_root)
    pipeline = request.get("pipeline", {})
    module_path = pipeline.get("module")
    try:
        module = _load_module(source_root, module_path)
    except BaseException as error:  # agent import errors of any kind are findings
        return [_issue("pipeline.module", "could not be imported", module_path, "a module that imports without error",
                       "Fix the import error and commit; importing must not fit models or read data.", _last_line(error))]
    factory = getattr(module, pipeline.get("factory", ""), None)
    if not callable(factory):
        callables = [name for name, value in vars(module).items() if callable(value) and not name.startswith("_")]
        close = difflib.get_close_matches(str(pipeline.get("factory")), callables, n=1, cutoff=0.6)
        return [_issue("pipeline.factory", "not a callable in the module", pipeline.get("factory"),
                       f"a function defined in {module_path}",
                       (f"Did you mean {close[0]}? " if close else "") + f"Callables in the module: {', '.join(sorted(callables)[:12]) or 'none'}.")]

    cv = request.get("cv", {})
    if cv.get("kind") == "factory":
        try:
            cv_module = _load_module(source_root, cv.get("module"))
            if not callable(getattr(cv_module, cv.get("factory", ""), None)):
                issues.append(_issue("cv.factory", "not a callable in the module", cv.get("factory"),
                                     f"a function defined in {cv.get('module')}", "Check the CV factory name and commit it."))
        except BaseException as error:
            issues.append(_issue("cv.module", "could not be imported", cv.get("module"), "a module that imports without error",
                                 "Fix the import error and commit.", _last_line(error)))

    fixed = pipeline.get("parameters", {})
    estimator_params: dict[str, Any] = pipeline.get("estimatorParams") or {}
    space: dict[str, dict[str, Any]] = (request.get("search") or {}).get("space", {})
    factory_space = {name[len(FACTORY_PREFIX):]: spec for name, spec in space.items() if name.startswith(FACTORY_PREFIX)}
    plain_space = {name: spec for name, spec in space.items() if not name.startswith(FACTORY_PREFIX)}
    base_overrides = {key: _candidates(spec)[0][1] for key, spec in factory_space.items() if _candidates(spec)}

    def build(overrides: dict[str, Any]) -> Any:
        parameters = {**fixed, **overrides} if isinstance(fixed, dict) else fixed
        context = {"parameters": parameters, "seed": 0}
        if measurement:
            context["measurement"] = {key: value for key, value in measurement.items()
                                      if key not in ("sampleManifestPath", "sampleManifestSha256")}
        return _call_pipeline_factory(factory, context)

    try:
        base = build(base_overrides)
    except BaseException as error:
        return issues + [_issue("pipeline.factory", "raised an error while building the pipeline",
                                {**fixed, **base_overrides} if isinstance(fixed, dict) else fixed,
                                "a factory that returns an unfitted estimator for these parameters",
                                "Fix the factory or its parameters; it must build without fitting or loading data.",
                                _last_line(error))]

    # Factory values can change the pipeline's structure, so a plain name is
    # valid if any variant exposes it.
    variants = [base]
    for key, spec in factory_space.items():
        for suffix, value in _candidates(spec):
            if value == base_overrides.get(key) and type(value) is type(base_overrides.get(key)):
                continue
            try:
                variants.append(build({**base_overrides, key: value}))
            except BaseException as error:
                issues.append(_issue(f"search.space.{FACTORY_PREFIX}{key}{suffix}", "rejected by the factory", value,
                                     f"a value {pipeline.get('factory')} accepts in context['parameters']['{key}']",
                                     "Handle this value in the factory, or remove it from the search space.", _last_line(error)))

    if not callable(getattr(base, "get_params", None)) or not callable(getattr(base, "set_params", None)):
        if estimator_params or plain_space:
            issues.append(_issue("pipeline.factory", "returned an estimator without get_params/set_params", type(base).__name__,
                                 "a scikit-learn compatible estimator or Pipeline",
                                 "Return a scikit-learn estimator, or search factory. parameters only."))
        return issues

    owners: dict[str, Any] = {}
    for variant in variants:
        try:
            for name in variant.get_params(deep=True):
                owners.setdefault(name, variant)
        except Exception as error:
            issues.append(_issue("pipeline.factory", "get_params(deep=True) failed", type(variant).__name__,
                                 "an estimator whose parameters can be listed", "Make the pipeline's components scikit-learn compatible.",
                                 _last_line(error)))
            return issues

    # Fixed factory inputs may construct invalid estimator settings without
    # raising. Validate their resulting defaults as well as explicit set_params
    # values; construction alone is not evidence of sklearn validity.
    checked_owners: set[int] = set()
    for variant in variants:
        candidates = [variant] + [value for value in variant.get_params(deep=True).values()
                                  if callable(getattr(value, "_validate_params", None))]
        for owner in candidates:
            if id(owner) in checked_owners:
                continue
            checked_owners.add(id(owner))
            validate = getattr(owner, "_validate_params", None)
            if not callable(validate) or not hasattr(owner, "_parameter_constraints"):
                continue
            try:
                validate()
            except Exception as error:
                issues.append(_issue("pipeline.parameters", f"constructed invalid {type(owner).__name__} parameters",
                                     fixed, "factory values producing valid estimator parameters",
                                     "Fix the factory parameters or the estimator defaults it constructs.", str(error)))

    checks: list[tuple[str, str, Any]] = [(f"pipeline.estimatorParams.{name}", name, value) for name, value in estimator_params.items()]
    for name, spec in plain_space.items():
        checks.extend((f"search.space.{name}{suffix}", name, value) for suffix, value in _candidates(spec))
    unknown: set[str] = set()
    for path, name, value in checks:
        if name not in owners:
            if name in unknown:
                continue
            unknown.add(name)
            close = difflib.get_close_matches(name, list(owners), n=1, cutoff=0.6)
            base_path = path.split(".choices[")[0].removesuffix(".low").removesuffix(".high").removesuffix(".sample")
            issues.append(_issue(base_path, "not a parameter of the pipeline", name, "a name from the pipeline's get_params()",
                                 (f"Did you mean {close[0]}? " if close else "") + _step_listing(name, owners)))
            continue
        problem = _check_value(owners[name], name, value, path)
        if problem:
            issues.append(problem)
    return issues
