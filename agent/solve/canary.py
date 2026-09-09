"""Filename-leakage canary.

Training files end in `.0` or `.1`, which encode the label exactly; test files
end in `.x`. A model that reads the filename scores near-perfectly in
cross-validation and is worthless on the real test set, and no aggregate metric
reveals it. This is the one check the stage gates on, because a failure
invalidates every other number in the run.

The check fits the agent's own pipeline twice on identical text -- once with the
real ids, once with ids rewritten to the neutral test-set form -- and requires
identical predictions.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from .corpus import load_examples, neutralize_ids
from .entrypoint import load_factory

MAX_EXAMPLES = 400


# What the canary concluded. A failure is not automatically a leak: the check
# has to load the agent's entrypoint and re-fit its pipeline before it can
# compare anything, and either of those can fail on its own. Reporting which
# one happened is what lets the stage say something true about it.
PASSED = "passed"
ID_DEPENDENCE = "id_dependence"
ENTRYPOINT_FAILED = "entrypoint_failed"
FIT_FAILED = "fit_failed"
SAMPLE_UNUSABLE = "sample_unusable"


@dataclass(frozen=True)
class CanaryResult:
    passed: bool
    reason: str
    examples: int
    kind: str = PASSED
    #: Wall time of one fit on `examples` rows. The stage turns this into a
    #: projected cross-validation cost, which is otherwise invisible until a
    #: session has already been spent on it.
    fit_seconds: float = 0.0

    def as_dict(self) -> dict:
        return {
            "passed": self.passed, "reason": self.reason, "examples": self.examples,
            "kind": self.kind, "fit_seconds": self.fit_seconds,
        }


def _sample(ids: Sequence[str], labels: Sequence[int], limit: int, seed: int) -> list[int]:
    """Balanced sample so both classes are represented in the fit."""
    rng = np.random.default_rng(seed)
    per_class = max(1, limit // 2)
    picked: list[int] = []
    for label in (0, 1):
        rows = np.flatnonzero(np.asarray(labels) == label)
        if rows.size == 0:
            continue
        picked.extend(rng.choice(rows, size=min(per_class, rows.size), replace=False).tolist())
    return sorted(picked)


def run_canary(
    project_root: Path,
    zip_path: Path,
    module_path: str,
    factory_name: str,
    ids: Sequence[str],
    labels: Sequence[int],
    seed: int = 13,
) -> CanaryResult:
    try:
        factory = load_factory(project_root, module_path, factory_name)
    except Exception as error:
        return CanaryResult(False, f"could not load entrypoint: {error}", 0, ENTRYPOINT_FAILED)

    rows = _sample(ids, labels, MAX_EXAMPLES, seed)
    if len(set(labels[row] for row in rows)) < 2:
        return CanaryResult(False, "sample does not contain both classes", len(rows), SAMPLE_UNUSABLE)

    try:
        real = load_examples(zip_path, [ids[row] for row in rows])
    except Exception as error:
        return CanaryResult(False, f"could not load canary examples: {error}", len(rows), SAMPLE_UNUSABLE)
    neutral = neutralize_ids(real)
    y = [labels[row] for row in rows]

    try:
        started = time.perf_counter()
        real_model = factory().fit(real, y)
        fit_seconds = time.perf_counter() - started
        real_output, output_kind = _output(real_model, real)
        neutral_output, _ = _output(factory().fit(neutral, y), neutral)
    except Exception as error:
        return CanaryResult(False, f"pipeline failed during the canary fit: {error}", len(rows), FIT_FAILED)

    differing = int(np.sum(np.abs(real_output - neutral_output) > TOLERANCE))
    if differing == 0:
        return CanaryResult(True, f"{output_kind} unchanged when ids are neutralized", len(rows), PASSED, fit_seconds)
    return CanaryResult(
        False,
        f"{differing} of {real_output.size} {output_kind} values changed when only the filename changed; "
        "the pipeline reads the id, which encodes the training label",
        len(rows),
        ID_DEPENDENCE,
        fit_seconds,
    )


TOLERANCE = 1e-8


def _output(model, frame) -> tuple[np.ndarray, str]:
    """Prefer a continuous output over hard labels.

    Comparing predicted labels only detects a leak that flips a decision. Where
    the text alone already separates the classes, a pipeline can read the
    filename and still predict identically, and the leak stays invisible until
    the test set, where the extension is a value the model never saw. Scores
    move as soon as the representation differs, so they detect the leak itself
    rather than one of its consequences.
    """
    for attribute, kind in (("predict_proba", "predicted probabilities"),
                            ("decision_function", "decision scores")):
        method = getattr(model, attribute, None)
        if callable(method):
            try:
                return np.asarray(method(frame), dtype=float), kind
            except Exception:
                continue
    return np.asarray(model.predict(frame), dtype=float), "predictions"
