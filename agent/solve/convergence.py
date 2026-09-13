"""Configured work against work actually done.

`max_iter=500` in a source file establishes nothing about what ran. The
estimator records the answer itself: `n_iter_` after a fit is the work
completed, and a `ConvergenceWarning` says the allowance ran out before the
tolerance was met. Both are free to read, and neither is visible to an agent
that never looks.

Everything here reads fitted attributes *after* `fit` returns. Reading them from
another thread while `fit` is still mutating the estimator is a data race, not a
measurement.
"""
from __future__ import annotations

import warnings
from contextlib import contextmanager
from typing import Any, Iterator

from sklearn.exceptions import ConvergenceWarning

#: Attributes that hold sub-estimators. A fit's real work is usually one level
#: down from whatever the factory returned, and a `Pipeline` reports nothing of
#: its own.
_CHILD_LISTS = ("steps", "transformer_list", "transformers_", "estimators_")
_CHILD_SINGLES = ("best_estimator_", "estimator_", "base_estimator_", "final_estimator_", "calibrated_classifiers_")
_MAX_DEPTH = 6

#: Configured allowances, in the order estimators tend to name them.
_BUDGETS = ("max_iter", "n_estimators", "max_epochs")

#: What `max_iter` counts, per estimator. It is not the same quantity across
#: them: an SGD iteration is a pass over every training row, an lbfgs iteration
#: is a solver step, and a tree ensemble has neither. Reporting a bare count
#: invites comparing numbers that measure different work -- and puts the word
#: "iteration" next to the solve loop's own iteration count, which is a whole
#: agent session rather than a few milliseconds of fitting.
_STEP_UNITS = {
    "SGDClassifier": "epochs",
    "SGDRegressor": "epochs",
    "MLPClassifier": "epochs",
    "MLPRegressor": "epochs",
    "Perceptron": "epochs",
    "PassiveAggressiveClassifier": "epochs",
}
_DEFAULT_STEP_UNIT = "solver steps"
_CONTROLS = ("early_stopping", "tol", "n_iter_no_change", "warm_start", "validation_fraction")


def _iterations(model: Any) -> int | None:
    """`n_iter_` as one number.

    Multi-class solvers report one entry per class or per target. The largest is
    the work the fit actually paid for.
    """
    value = getattr(model, "n_iter_", None)
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        numbers = [int(entry) for entry in value]
    except (TypeError, ValueError):
        return None
    return max(numbers) if numbers else None


def _record(model: Any, path: str) -> dict | None:
    """One estimator's configured allowance against its completed work.

    Returns nothing for estimators that neither declare an allowance nor report
    completed iterations: a `TfidfVectorizer` has no convergence story, and
    listing it as absent-everything is noise.
    """
    completed = _iterations(model)
    configured = {name: getattr(model, name) for name in _BUDGETS if getattr(model, name, None) is not None}
    if completed is None and not configured:
        return None
    controls = {name: getattr(model, name) for name in _CONTROLS if hasattr(model, name)}
    name = type(model).__name__
    record: dict[str, Any] = {
        "estimator": name,
        "path": path,
        "step_unit": _STEP_UNITS.get(name, _DEFAULT_STEP_UNIT),
        "configured": {name: _plain(value) for name, value in configured.items()},
        "controls": {name: _plain(value) for name, value in controls.items()},
    }
    if completed is not None:
        record["completed_iterations"] = completed
        allowance = configured.get("max_iter")
        if isinstance(allowance, int) and allowance > 0:
            # The distinction the agent needs: a fit that stopped early bought
            # its remaining allowance back, and one that hit the ceiling was cut
            # off rather than finished.
            record["configured_iterations"] = allowance
            record["reached_limit"] = completed >= allowance
    return record


def _plain(value: Any) -> Any:
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    return str(value)


def inspect_fitted(model: Any) -> list[dict]:
    """Walk a fitted estimator and record what each part configured and completed."""
    found: list[dict] = []
    seen: set[int] = set()

    def walk(node: Any, path: str, depth: int) -> None:
        if node is None or depth > _MAX_DEPTH or id(node) in seen:
            return
        seen.add(id(node))
        record = _record(node, path)
        if record:
            found.append(record)
        for attribute in _CHILD_LISTS:
            children = getattr(node, attribute, None)
            if not isinstance(children, (list, tuple)):
                continue
            for entry in children:
                # `steps` and `transformer_list` hold (name, estimator) pairs;
                # `estimators_` holds bare estimators.
                if isinstance(entry, tuple) and len(entry) >= 2 and isinstance(entry[0], str):
                    walk(entry[1], f"{path}.{entry[0]}" if path else str(entry[0]), depth + 1)
                else:
                    walk(entry, path, depth + 1)
        for attribute in _CHILD_SINGLES:
            walk(getattr(node, attribute, None), path, depth + 1)

    try:
        walk(model, "", 0)
    except Exception:  # a measurement never fails the thing it measures
        return found
    return found


@contextmanager
def capture_convergence_warnings() -> Iterator[list[str]]:
    """Collect `ConvergenceWarning`s raised inside the block.

    scikit-learn raises these once per fit and Python's default filter shows
    each unique warning once per location, so a caught warning is the only
    reliable record that an allowance ran out.
    """
    collected: list[str] = []
    with warnings.catch_warnings(record=True) as raised:
        warnings.simplefilter("always", ConvergenceWarning)
        yield collected
        for entry in raised:
            if issubclass(entry.category, ConvergenceWarning):
                collected.append(str(entry.message).strip().splitlines()[0][:300])


def summarise(model: Any, scope: str, rows: int, warnings_raised: list[str]) -> dict:
    """The block the stage records and renders."""
    return {
        "scope": scope,
        "rows": rows,
        "estimators": inspect_fitted(model),
        "convergence_warnings": warnings_raised,
    }
