"""Write the solve stage's results contract.

The stage reads exactly two prediction files and one metrics file. Building them
by hand is easy to get subtly wrong -- a duplicated row, a missing sealed id, a
mean taken over the wrong axis -- and every one of those failures looks like a
bad model rather than a bad write. `Results` accumulates fold predictions and
emits the contract, checking the parts the stage will check anyway so a mistake
surfaces here with a useful message instead of at the end of the run.

Anything that writes the same files grades identically, so this is not a
gatekeeper. It is what the prompt tells the agent to use, and it validates ids
as they arrive so a contract mistake surfaces here rather than after the run.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from . import metrics as _metrics
from .corpus import id_form_hint

SCHEMA_VERSION = 1


@dataclass
class _Row:
    id: str
    repeat: int
    fold: int
    prediction: int
    score: float | None


@dataclass
class Results:
    """Accumulates out-of-fold and sealed-set predictions, then writes them out.

    `workspace` defaults to the `SOLVE_WORKSPACE` the stage exports, so a script
    run from anywhere under the project writes to the right run directory.
    """

    workspace: Path | None = None
    _oof: list[_Row] = field(default_factory=list, repr=False)
    _known: set[str] | None = field(default=None, repr=False)
    _sealed: set[str] | None = field(default=None, repr=False)
    _seen: set[tuple[int, str]] = field(default_factory=set, repr=False)
    _folds: list[_metrics.FoldScores] = field(default_factory=list, repr=False)
    _labels: dict[str, int] = field(default_factory=dict, repr=False)
    _confirmation: list[_Row] = field(default_factory=list, repr=False)

    def __post_init__(self) -> None:
        if self.workspace is None:
            location = os.environ.get("SOLVE_WORKSPACE")
            if not location:
                raise ValueError("No workspace given and SOLVE_WORKSPACE is not set")
            self.workspace = Path(location)
        self.workspace = Path(self.workspace)
        self._known, self._sealed = _workspace_ids(self.workspace)

    def add_fold(
        self,
        repeat: int,
        fold: int,
        ids: Sequence[str],
        y_true: Sequence[int],
        y_pred: Sequence[int],
        y_score: Sequence[float] | None = None,
    ) -> _metrics.FoldScores:
        """Record one validation fold and return its measurements immediately.

        The returned scores are the same ones written to `metrics.json`, so an
        inner loop can print per-fold results as it goes.
        """
        if not (len(ids) == len(y_true) == len(y_pred)):
            raise ValueError("ids, y_true and y_pred must have the same length")
        if y_score is not None and len(y_score) != len(ids):
            raise ValueError("y_score must have the same length as ids")
        self._check_development_ids(ids)
        for position, row_id in enumerate(ids):
            key = (repeat, row_id)
            if key in self._seen:
                raise ValueError(f"{row_id} already has a prediction for repeat {repeat}")
            self._seen.add(key)
            previous = self._labels.get(row_id)
            if previous is not None and previous != int(y_true[position]):
                raise ValueError(f"{row_id} was given label {previous} and then {int(y_true[position])}")
            self._labels[row_id] = int(y_true[position])
            self._oof.append(_Row(
                id=row_id,
                repeat=repeat,
                fold=fold,
                prediction=int(y_pred[position]),
                score=None if y_score is None else float(y_score[position]),
            ))
        try:
            scored = _metrics.score_fold(repeat, fold, y_true, y_pred, y_score)
        except ValueError as error:
            # Naming the fold matters: the usual cause is an unstratified split
            # that put one class entirely outside this validation fold.
            raise ValueError(f"repeat {repeat} fold {fold}: {error}") from error
        self._folds.append(scored)
        return scored

    def set_confirmation(
        self,
        ids: Sequence[str],
        y_pred: Sequence[int],
        y_score: Sequence[float] | None = None,
    ) -> None:
        """Deprecated: the harness scores the held-out split itself.

        Kept so existing scripts do not break. The held-out rows are not in the
        data the stage provides, and anything written here is ignored.
        """
        if len(ids) != len(y_pred):
            raise ValueError("ids and y_pred must have the same length")
        self._check_sealed_ids(ids)
        self._confirmation = [
            _Row(id=row_id, repeat=-1, fold=-1, prediction=int(y_pred[position]),
                 score=None if y_score is None else float(y_score[position]))
            for position, row_id in enumerate(ids)
        ]

    def _check_development_ids(self, ids: Sequence[str]) -> None:
        """Refuse ids the stage will not recognise, at the point they are supplied.

        The stage checks the same thing when it grades the run, but by then the
        session is over and the agent cannot act on it. An id written in the
        wrong form invalidates every row at once, so catching it on the first
        fold turns a lost run into a one-line correction.
        """
        if self._known is None:
            return
        sealed = [row_id for row_id in ids if self._sealed and row_id in self._sealed]
        if sealed:
            raise ValueError(
                f"{len(sealed)} of these ids are sealed, first {sealed[0]!r}; the confirmation "
                "split must stay out of cross-validation and belongs in set_confirmation()",
            )
        unknown = [row_id for row_id in ids if row_id not in self._known]
        if unknown:
            raise ValueError(
                f"{len(unknown)} of these ids are not development rows, first {unknown[0]!r}"
                f"{id_form_hint(unknown, self._known)}",
            )

    def _check_sealed_ids(self, ids: Sequence[str]) -> None:
        if self._sealed is None:
            return
        unknown = [row_id for row_id in ids if row_id not in self._sealed]
        if unknown:
            raise ValueError(
                f"{len(unknown)} of these ids are not sealed rows, first {unknown[0]!r}"
                f"{id_form_hint(unknown, self._sealed)}. read_sealed_ids() returns exactly "
                "the ids this file must cover",
            )

    def _check_coverage(self) -> None:
        """Every development row needs a prediction in every repeat."""
        if self._known is None:
            return
        by_repeat: dict[int, set[str]] = {}
        for row in self._oof:
            by_repeat.setdefault(row.repeat, set()).add(row.id)
        for repeat, seen in sorted(by_repeat.items()):
            missing = self._known - seen
            if missing:
                raise ValueError(
                    f"repeat {repeat} covers {len(seen)} of {len(self._known)} development rows; "
                    f"every row needs an out-of-fold prediction, first missing {sorted(missing)[0]!r}",
                )


    def mean_balanced_accuracy(self) -> float:
        """Mean of the per-fold balanced accuracies -- the headline number."""
        if not self._folds:
            raise ValueError("no folds recorded")
        return sum(fold.bacc for fold in self._folds) / len(self._folds)

    def pooled_balanced_accuracy(self) -> float:
        """Balanced accuracy over all out-of-fold rows of one repeat pass."""
        by_repeat = {}
        for row in self._oof:
            by_repeat.setdefault(row.repeat, []).append(row)
        scores = [
            _metrics.balanced_accuracy([self._labels[row.id] for row in rows], [row.prediction for row in rows])
            for rows in by_repeat.values()
        ]
        return sum(scores) / len(scores)

    def curves(self) -> dict:
        """ROC, precision/recall and threshold diagnostics over pooled scores."""
        scored = [row for row in self._oof if row.score is not None]
        if len(scored) < len(self._oof) or not scored:
            return {}
        truth = [self._labels[row.id] for row in scored]
        values = [row.score for row in scored]
        if len(set(truth)) < 2:
            return {}
        return {
            "roc": _metrics.roc(truth, values).as_dict(),
            "precision_recall": _metrics.precision_recall(truth, values),
            "threshold_sweep": _metrics.threshold_sweep(truth, values),
            "calibration": _metrics.calibration(truth, values),
        }

    def write(
        self,
        cv: dict,
        entrypoint: dict,
        approach: str,
        variants_compared: int = 1,
        done: bool = False,
        extra: dict | None = None,
    ) -> Path:
        """Write the contract and return the path to `metrics.json`."""
        if not self._folds:
            raise ValueError("nothing to write: no folds were recorded")
        for required, value in (("scheme", cv.get("scheme")), ("folds", cv.get("folds")),
                                ("repeats", cv.get("repeats")), ("seed", cv.get("seed"))):
            if value is None:
                raise ValueError(f"cv is missing '{required}'")
        for required in ("module", "factory"):
            if not entrypoint.get(required):
                raise ValueError(f"entrypoint is missing '{required}'")
        self._check_coverage()

        workspace = self.workspace
        workspace.mkdir(parents=True, exist_ok=True)
        _write_predictions(workspace / "oof_predictions.csv", self._oof, folded=True)

        curves = self.curves()
        if curves:
            (workspace / "curves.json").write_text(json.dumps(curves), encoding="utf-8")

        document = {
            "schema_version": SCHEMA_VERSION,
            "cv": cv,
            "entrypoint": entrypoint,
            "mean_bacc": self.mean_balanced_accuracy(),
            "pooled_bacc": self.pooled_balanced_accuracy(),
            "folds": [fold.as_dict() for fold in self._folds],
            "approach": approach,
            "variants_compared": int(variants_compared),
            "done": bool(done),
            **(extra or {}),
        }
        target = workspace / "metrics.json"
        target.write_text(f"{json.dumps(document, indent=2)}\n", encoding="utf-8")
        return target


def _write_predictions(path: Path, rows: Sequence[_Row], folded: bool) -> None:
    scored = any(row.score is not None for row in rows)
    if scored and any(row.score is None for row in rows):
        raise ValueError(f"{path.name}: supply a score for every row or for none")
    header = (["id", "repeat", "fold"] if folded else ["id"]) + ["prediction"] + (["score"] if scored else [])
    lines = [";".join(header)]
    for row in rows:
        fields = ([row.id, str(row.repeat), str(row.fold)] if folded else [row.id]) + [str(row.prediction)]
        if scored:
            fields.append(repr(row.score))
        lines.append(";".join(fields))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _workspace_ids(workspace: Path) -> tuple[set[str] | None, set[str] | None]:
    """The development and sealed id sets, when the workspace holds them.

    Both are absent outside a prepared run workspace, and validation is then
    skipped rather than made a requirement: `Results` stays usable anywhere that
    writes the same files.
    """
    sealed_path = workspace / "data" / "sealed_ids.txt"
    sealed = None
    if sealed_path.is_file():
        sealed = {line.strip() for line in sealed_path.read_text(encoding="utf-8").splitlines() if line.strip()}

    known = None
    labels = sorted((workspace / "data").glob("*-dev.labels")) if (workspace / "data").is_dir() else []
    if labels:
        known = set()
        for line in labels[0].read_text(encoding="utf-8").splitlines():
            row_id, separator, _ = line.strip().rpartition(";")
            if separator and row_id:
                known.add(row_id)
    return known, sealed


def read_sealed_ids(workspace: Path | str | None = None) -> list[str]:
    """Read the sealed ids the stage withheld, in file order."""
    location = Path(workspace or os.environ.get("SOLVE_WORKSPACE", ""))
    if not location.name:
        raise ValueError("No workspace given and SOLVE_WORKSPACE is not set")
    text = (location / "data" / "sealed_ids.txt").read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip()]
