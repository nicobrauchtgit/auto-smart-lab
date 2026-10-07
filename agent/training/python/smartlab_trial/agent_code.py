"""Loading and initializing agent-provided factories."""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from .invocation import InvocationError
from .seeds import _derive_seed


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


def expose_project(project_root: Path) -> None:
    """Allow solution factories to import reusable project helpers.

    For a versioned trial this is the trial's source root, whose `solutions`
    directory is a worktree of the trial's commit, so `solutions.x` resolves to
    that commit. PYTHONPATH carries the same root into child interpreters such
    as joblib's loky workers, which re-import agent modules from disk.
    """
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    existing = [entry for entry in os.environ.get("PYTHONPATH", "").split(os.pathsep) if entry]
    if str(project_root) not in existing:
        os.environ["PYTHONPATH"] = os.pathsep.join([str(project_root), *existing])
