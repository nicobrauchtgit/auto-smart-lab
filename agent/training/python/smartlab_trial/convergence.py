"""Convergence information for search events, from `agent/solve/convergence.py`.

The solve package is loaded by path so the worker keeps one implementation of
what "configured versus completed work" means. Failing to load it never fails a
fit: a measurement never breaks the thing it measures.
"""
from __future__ import annotations

import contextlib
import importlib.util
from pathlib import Path
from typing import Any, Iterator

_SOURCE = Path(__file__).resolve().parents[3] / "solve" / "convergence.py"


def _load() -> Any:
    try:
        spec = importlib.util.spec_from_file_location("smartlab_solve_convergence", _SOURCE)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


_MODULE = _load()


@contextlib.contextmanager
def capture_convergence_warnings() -> Iterator[list[str]]:
    if _MODULE is None:
        yield []
        return
    with _MODULE.capture_convergence_warnings() as raised:
        yield raised


def summarise_convergence(estimator: Any, warnings_raised: list[str]) -> dict[str, Any]:
    if _MODULE is None:
        return {"available": False}
    estimators = _MODULE.inspect_fitted(estimator)
    return {
        "estimators": estimators,
        "warnings": warnings_raised,
        "reachedLimit": any(entry.get("reached_limit") is True for entry in estimators),
    }
