"""Classification diagnostics for the solve stage.

Feed in classified data -- true labels with predicted labels, and scores where a
model produces them -- and get back the measurements the improvement loop is
judged on. Nothing here decides anything about a model; it only measures, so the
same numbers mean the same thing across iterations and across tasks.

Balanced accuracy is the metric the SmartLab tasks are scored on, so it is the
one every helper reports.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np


def _as_labels(values: Sequence[int]) -> np.ndarray:
    array = np.asarray(values)
    if array.ndim != 1:
        raise ValueError("labels must be one-dimensional")
    if array.size == 0:
        raise ValueError("labels must not be empty")
    unknown = set(np.unique(array)) - {0, 1}
    if unknown:
        raise ValueError(f"labels must be 0 or 1; found {sorted(unknown)}")
    return array.astype(np.int8)


def confusion(y_true: Sequence[int], y_pred: Sequence[int]) -> dict[str, int]:
    """Raw counts. At high scores these matter more than any rounded rate."""
    truth, predicted = _as_labels(y_true), _as_labels(y_pred)
    if truth.shape != predicted.shape:
        raise ValueError("y_true and y_pred must have the same length")
    return {
        "tn": int(np.sum((truth == 0) & (predicted == 0))),
        "fp": int(np.sum((truth == 0) & (predicted == 1))),
        "fn": int(np.sum((truth == 1) & (predicted == 0))),
        "tp": int(np.sum((truth == 1) & (predicted == 1))),
    }


def per_class_recall(y_true: Sequence[int], y_pred: Sequence[int]) -> dict[str, float]:
    counts = confusion(y_true, y_pred)
    negatives = counts["tn"] + counts["fp"]
    positives = counts["tp"] + counts["fn"]
    if negatives == 0 or positives == 0:
        raise ValueError("balanced accuracy needs both classes present")
    return {"recall_0": counts["tn"] / negatives, "recall_1": counts["tp"] / positives}


def balanced_accuracy(y_true: Sequence[int], y_pred: Sequence[int]) -> float:
    """Mean of the two class recalls: the metric these tasks are scored on."""
    recall = per_class_recall(y_true, y_pred)
    return (recall["recall_0"] + recall["recall_1"]) / 2


@dataclass(frozen=True)
class RocCurve:
    fpr: list[float]
    tpr: list[float]
    thresholds: list[float]
    auc: float

    def as_dict(self) -> dict:
        return {"fpr": self.fpr, "tpr": self.tpr, "thresholds": self.thresholds, "auc": self.auc}


def roc(y_true: Sequence[int], y_score: Sequence[float], max_points: int = 512) -> RocCurve:
    """ROC curve and AUC, thinned to `max_points` so a curve stays storable.

    AUC is computed on the full curve before thinning, so the reported number is
    not an artefact of how many points were kept for plotting.
    """
    from sklearn.metrics import auc as _auc, roc_curve as _roc_curve

    truth = _as_labels(y_true)
    scores = np.asarray(y_score, dtype=float)
    if truth.shape != scores.shape:
        raise ValueError("y_true and y_score must have the same length")
    if not np.all(np.isfinite(scores)):
        raise ValueError("scores must be finite")
    fpr, tpr, thresholds = _roc_curve(truth, scores)
    area = float(_auc(fpr, tpr))
    keep = _thin(len(fpr), max_points)
    return RocCurve(
        fpr=[float(value) for value in fpr[keep]],
        tpr=[float(value) for value in tpr[keep]],
        # roc_curve's first threshold is +inf by construction; keep it finite so
        # the curve round-trips through JSON.
        thresholds=[float(value) if np.isfinite(value) else float(np.max(scores)) + 1.0 for value in thresholds[keep]],
        auc=area,
    )


def precision_recall(y_true: Sequence[int], y_score: Sequence[float], max_points: int = 512) -> dict:
    """Precision/recall curve and average precision."""
    from sklearn.metrics import average_precision_score, precision_recall_curve

    truth = _as_labels(y_true)
    scores = np.asarray(y_score, dtype=float)
    precision, recall, thresholds = precision_recall_curve(truth, scores)
    keep = _thin(len(thresholds), max_points)
    return {
        "precision": [float(value) for value in precision[keep]],
        "recall": [float(value) for value in recall[keep]],
        "thresholds": [float(value) for value in thresholds[keep]],
        "average_precision": float(average_precision_score(truth, scores)),
    }


def _thin(length: int, max_points: int) -> np.ndarray:
    if length <= max_points:
        return np.arange(length)
    return np.unique(np.linspace(0, length - 1, max_points).astype(int))


def threshold_sweep(y_true: Sequence[int], y_score: Sequence[float], tolerance: float = 0.001) -> dict:
    """Balanced accuracy across every threshold, and how fragile the best one is.

    Balanced accuracy at a threshold is `(tpr + (1 - fpr)) / 2`, so the whole
    sweep falls out of the ROC curve at no extra cost. `plateau` reports the
    threshold range staying within `tolerance` of the best score: a wide plateau
    means the operating point is robust, a narrow one means the score depends on
    a threshold that may not transfer.
    """
    from sklearn.metrics import roc_curve as _roc_curve

    truth = _as_labels(y_true)
    scores = np.asarray(y_score, dtype=float)
    fpr, tpr, thresholds = _roc_curve(truth, scores)
    finite = np.isfinite(thresholds)
    fpr, tpr, thresholds = fpr[finite], tpr[finite], thresholds[finite]
    if thresholds.size == 0:
        raise ValueError("no finite thresholds; scores may be constant")
    bacc = (tpr + (1.0 - fpr)) / 2.0
    best = int(np.argmax(bacc))
    within = thresholds[bacc >= bacc[best] - tolerance]
    return {
        "best_threshold": float(thresholds[best]),
        "best_balanced_accuracy": float(bacc[best]),
        "at_default_threshold": float(_bacc_at(truth, scores, 0.5)),
        "plateau": {
            "tolerance": tolerance,
            "low": float(np.min(within)),
            "high": float(np.max(within)),
            "count": int(within.size),
        },
        "curve": {
            "thresholds": [float(value) for value in thresholds[_thin(len(thresholds), 512)]],
            "balanced_accuracy": [float(value) for value in bacc[_thin(len(bacc), 512)]],
        },
    }


def _bacc_at(truth: np.ndarray, scores: np.ndarray, threshold: float) -> float:
    predicted = (scores >= threshold).astype(np.int8)
    try:
        return balanced_accuracy(truth, predicted)
    except ValueError:
        return float("nan")


def calibration(y_true: Sequence[int], y_score: Sequence[float], bins: int = 10) -> dict:
    """Reliability curve: how far predicted scores sit from observed frequency.

    Only meaningful when scores are probabilities. A decision-function output
    will look badly calibrated by construction, which is not a defect.
    """
    truth = _as_labels(y_true)
    scores = np.asarray(y_score, dtype=float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    index = np.clip(np.digitize(scores, edges[1:-1]), 0, bins - 1)
    rows = []
    for bin_number in range(bins):
        mask = index == bin_number
        if not np.any(mask):
            continue
        rows.append({
            "bin": bin_number,
            "count": int(np.sum(mask)),
            "mean_score": float(np.mean(scores[mask])),
            "observed_rate": float(np.mean(truth[mask])),
        })
    error = sum(row["count"] * abs(row["mean_score"] - row["observed_rate"]) for row in rows)
    return {"bins": rows, "expected_calibration_error": error / truth.size if truth.size else float("nan")}


def compare(
    y_true: Sequence[int],
    baseline_pred: Sequence[int],
    candidate_pred: Sequence[int],
) -> dict:
    """Paired comparison of two prediction sets on the same examples.

    At a high score the aggregate difference hides what changed. Corrected and
    introduced counts say whether a gain is a real improvement or a reshuffle of
    which examples are wrong.
    """
    truth = _as_labels(y_true)
    baseline = _as_labels(baseline_pred)
    candidate = _as_labels(candidate_pred)
    if not (truth.shape == baseline.shape == candidate.shape):
        raise ValueError("all three inputs must have the same length")
    baseline_right = baseline == truth
    candidate_right = candidate == truth
    return {
        "baseline_balanced_accuracy": balanced_accuracy(truth, baseline),
        "candidate_balanced_accuracy": balanced_accuracy(truth, candidate),
        "delta": balanced_accuracy(truth, candidate) - balanced_accuracy(truth, baseline),
        "corrected": int(np.sum(~baseline_right & candidate_right)),
        "introduced": int(np.sum(baseline_right & ~candidate_right)),
        "disagreements": int(np.sum(baseline != candidate)),
    }


def paired_bootstrap(
    y_true: Sequence[int],
    baseline_pred: Sequence[int],
    candidate_pred: Sequence[int],
    resamples: int = 2000,
    seed: int = 13,
    confidence: float = 0.95,
) -> dict:
    """Stratified paired-bootstrap interval for the balanced-accuracy delta.

    Resampling within each class keeps the class proportions fixed, which matters
    because balanced accuracy is a mean of two per-class rates. An interval
    containing zero means the observed difference is not distinguishable from
    resampling noise.
    """
    truth = _as_labels(y_true)
    baseline = _as_labels(baseline_pred)
    candidate = _as_labels(candidate_pred)
    rng = np.random.default_rng(seed)
    class_rows = [np.flatnonzero(truth == label) for label in (0, 1)]
    if any(rows.size == 0 for rows in class_rows):
        raise ValueError("paired bootstrap needs both classes present")
    deltas = np.empty(resamples, dtype=float)
    for draw in range(resamples):
        picked = np.concatenate([rng.choice(rows, size=rows.size, replace=True) for rows in class_rows])
        deltas[draw] = balanced_accuracy(truth[picked], candidate[picked]) - balanced_accuracy(truth[picked], baseline[picked])
    tail = (1.0 - confidence) / 2.0
    low, high = np.quantile(deltas, [tail, 1.0 - tail])
    observed = balanced_accuracy(truth, candidate) - balanced_accuracy(truth, baseline)
    return {
        "delta": float(observed),
        "low": float(low),
        "high": float(high),
        "confidence": confidence,
        "resamples": resamples,
        # The interval excluding zero is the evidence that a change is real. It
        # is not a significance test and does not correct for repeated looks.
        "clears_zero": bool(low > 0.0 or high < 0.0),
    }


@dataclass
class FoldScores:
    """One fold's measurements, in the shape `metrics.json` expects."""

    repeat: int
    fold: int
    n: int
    bacc: float
    recall_0: float
    recall_1: float
    confusion: dict[str, int] = field(default_factory=dict)
    roc_auc: float | None = None

    def as_dict(self) -> dict:
        row = {
            "repeat": self.repeat,
            "fold": self.fold,
            "n": self.n,
            "bacc": self.bacc,
            "recall_0": self.recall_0,
            "recall_1": self.recall_1,
            "confusion": self.confusion,
        }
        if self.roc_auc is not None:
            row["roc_auc"] = self.roc_auc
        return row


def score_fold(
    repeat: int,
    fold: int,
    y_true: Sequence[int],
    y_pred: Sequence[int],
    y_score: Sequence[float] | None = None,
) -> FoldScores:
    """Measure one fold. ROC AUC is included when scores are supplied."""
    recall = per_class_recall(y_true, y_pred)
    return FoldScores(
        repeat=repeat,
        fold=fold,
        n=len(y_true),
        bacc=(recall["recall_0"] + recall["recall_1"]) / 2,
        recall_0=recall["recall_0"],
        recall_1=recall["recall_1"],
        confusion=confusion(y_true, y_pred),
        roc_auc=roc(y_true, y_score).auc if y_score is not None else None,
    )
