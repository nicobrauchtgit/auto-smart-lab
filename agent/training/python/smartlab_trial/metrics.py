"""Authoritative prediction measurements."""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np
from sklearn.metrics import balanced_accuracy_score, confusion_matrix, recall_score


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
