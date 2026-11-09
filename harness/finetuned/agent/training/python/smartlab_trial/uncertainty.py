"""Advisory uncertainty and empirical operating points; no selection-policy changes."""
import math
from typing import Any

import numpy as np
from scipy.stats import beta, t
from sklearn.metrics import roc_auc_score, roc_curve

from .diagnostics import finite_vector, unavailable


def binomial_interval(successes: int, trials: int) -> list[float] | None:
    if not trials:
        return None
    return [float(beta.ppf(.025, successes, trials - successes + 1)) if successes else 0.0,
            float(beta.ppf(.975, successes + 1, trials - successes)) if successes < trials else 1.0]


def operating_points(truth: Any, scores: Any, predictions: Any = None) -> dict[str, Any]:
    if scores is None or len(set(truth)) < 2:
        return unavailable("Operating points require continuous scores and both classes")
    values = finite_vector(scores, len(truth), "Operating-point scores")
    positive, negative = sum(int(y == 1) for y in truth), sum(int(y == 0) for y in truth)
    fpr, tpr, thresholds = roc_curve(truth, values, drop_intermediate=False)
    points = []
    for cap in (.001, .01, .05):
        valid = np.flatnonzero(fpr <= cap)
        best = int(valid[np.argmax(tpr[valid])])
        fp, tp = int(round(fpr[best] * negative)), int(round(tpr[best] * positive))
        points.append({"maxFpr": cap, "achievedFpr": float(fpr[best]), "recall": float(tpr[best]),
                       "falsePositives": fp, "truePositives": tp,
                       "precision": tp / (tp + fp) if tp + fp else None,
                       "threshold": float(thresholds[best]) if np.isfinite(thresholds[best]) else None,
                       "thresholdAboveMaximum": bool(not np.isfinite(thresholds[best])),
                       "standardizedPartialAuc": float(roc_auc_score(truth, values, max_fpr=cap)),
                       "chancePartialAuc": .5, "capBelowOneFalsePositive": cap < 1 / negative})
    result = {"available": True, "advisory": True, "selectedOnEvaluationRows": True,
              "positiveRows": positive, "negativeRows": negative, "fprResolution": 1 / negative,
              "points": points, "interpolationForRecall": False}
    if predictions is not None:
        truth_array, predicted = np.asarray(truth), np.asarray(predictions)
        fp = int(np.sum((truth_array == 0) & (predicted == 1)))
        tp = int(np.sum((truth_array == 1) & (predicted == 1)))
        result["pipelineDecision"] = {"falsePositives": fp, "truePositives": tp, "fpr": fp / negative,
                                      "recall": tp / positive, "fprBinomialInterval95": binomial_interval(fp, negative),
                                      "recallBinomialInterval95": binomial_interval(tp, positive),
                                      "intervalAssumesIndependentExamplesAndFixedDecisionRule": True}
    return result


def corrected_cv(differences: list[float], folds: list[dict[str, Any]]) -> dict[str, Any]:
    if len(differences) < 2 or len(folds) != len(differences):
        return unavailable("Corrected CV uncertainty needs two or more paired folds with recorded scope")
    if any(fold.get("execution", "inductive") != "inductive" or not fold.get("trainRows") or not fold.get("validationRows") for fold in folds):
        return unavailable("Train-overlap correction requires inductive fits and recorded train/validation row counts")
    ratio = float(np.mean([fold["validationRows"] / fold["trainRows"] for fold in folds]))
    variance = float(np.var(differences, ddof=1))
    error = math.sqrt((1 / len(differences) + ratio) * variance)
    mean = float(np.mean(differences))
    critical = float(t.ppf(.975, len(differences) - 1))
    return {"available": True, "advisory": True, "approximate": True,
            "method": "Nadeau-Bengio corrected resampled t approximation",
            "meanValidationTrainRatio": ratio, "standardError": error,
            "interval95": [mean - critical * error, mean + critical * error],
            "degreesOfFreedom": len(differences) - 1, "zeroEmpiricalVariance": variance == 0,
            "assumesIndependentOriginalSamples": True, "accountsForSearchSelection": False,
            "changesPromotionRule": False}
