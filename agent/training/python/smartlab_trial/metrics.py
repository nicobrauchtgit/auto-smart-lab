"""Authoritative prediction measurements."""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np
from sklearn.metrics import balanced_accuracy_score, confusion_matrix, precision_recall_fscore_support


def _scores(estimator: Any, validation: Any) -> list[float] | None:
    return score_observation(estimator, validation)[0]


def score_observation(estimator: Any, validation: Any) -> tuple[list[float] | None, dict[str, Any]]:
    from .diagnostics import finite_vector
    if callable(getattr(estimator, "predict_proba", None)):
        probabilities = np.asarray(estimator.predict_proba(validation))
        if probabilities.ndim == 2 and probabilities.shape[1] == 2:
            if (probabilities.shape[0] != len(validation) or not np.all(np.isfinite(probabilities))
                    or np.any((probabilities < 0) | (probabilities > 1))
                    or not np.allclose(probabilities.sum(axis=1), 1, atol=1e-6)):
                raise ValueError("predict_proba must return finite normalized probabilities in [0, 1]")
            classes = list(getattr(estimator, "classes_", [0, 1]))
            if sorted(classes) != [0, 1]:
                raise ValueError("Probability classes must be binary labels 0 and 1")
            values = finite_vector(probabilities[:, classes.index(1)], len(validation), "Probability scores")
            return values.tolist(), {"kind": "probability", "method": "predict_proba", "positiveLabel": 1}
    if callable(getattr(estimator, "decision_function", None)):
        values = np.asarray(estimator.decision_function(validation))
        if values.ndim == 1:
            values = finite_vector(values, len(validation), "Decision scores")
            classes = list(getattr(estimator, "classes_", [0, 1]))
            if sorted(classes) != [0, 1]:
                raise ValueError("Decision score classes must be binary labels 0 and 1")
            if classes[-1] != 1:
                values = -values
            return values.tolist(), {"kind": "margin", "method": "decision_function", "positiveLabel": 1}
    return None, {"kind": "unavailable"}


def _measure(truth: Sequence[int], predicted: Sequence[int]) -> dict[str, Any]:
    labels = sorted(set(int(value) for value in truth))
    precision, recalls, f1, support = precision_recall_fscore_support(truth, predicted, labels=labels, average=None, zero_division=0)
    return {
        "balancedAccuracy": float(balanced_accuracy_score(truth, predicted)),
        "perClassRecall": {str(label): float(value) for label, value in zip(labels, recalls)},
        "confusionMatrix": confusion_matrix(truth, predicted, labels=labels).tolist(),
        "labels": labels,
        "macroF1": float(np.mean(f1)),
        "perClass": {str(label): {"precision": float(p), "recall": float(r), "f1": float(f), "support": int(n)}
                     for label, p, r, f, n in zip(labels, precision, recalls, f1, support)},
    }
