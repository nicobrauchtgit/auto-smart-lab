"""Harness measurements from authoritative predictions; never fit agent code.

Partitions and score scales belong to a fold, not a pooled OOF vector. Stability
compares common IDs between different repeats. All label-free signals are proxies.
"""
from __future__ import annotations

from collections import defaultdict
from itertools import combinations
from typing import Any, Sequence

import numpy as np
from scipy.stats import kendalltau, spearmanr
from sklearn.metrics import (adjusted_rand_score, average_precision_score,
                             brier_score_loss, homogeneity_completeness_v_measure,
                             log_loss, roc_auc_score, roc_curve)
from sklearn.metrics.cluster import contingency_matrix, pair_confusion_matrix


def unavailable(reason: str) -> dict[str, Any]:
    return {"available": False, "reason": reason}


def spread(values: Sequence[float]) -> dict[str, Any]:
    if not values:
        return unavailable("No completed measurements.")
    return {"available": True, "count": len(values), "mean": float(np.mean(values)),
            "std": float(np.std(values)), "min": float(min(values)), "max": float(max(values))}


def finite_vector(values: Any, rows: int, name: str) -> np.ndarray:
    array = np.asarray(values, dtype=float)
    if array.shape != (rows,) or not np.all(np.isfinite(array)):
        raise ValueError(f"{name} must contain exactly {rows} finite scalar values")
    return array


def classification(truth: Sequence[int], predicted: Sequence[int], scores: Any,
                   provenance: dict[str, Any]) -> dict[str, Any]:
    if scores is None:
        return {"scoreProvenance": provenance, "ranking": unavailable("Continuous scores unavailable."),
                "thresholdSweep": unavailable("Continuous scores unavailable."),
                "calibration": unavailable("Probabilities unavailable.")}
    values = finite_vector(scores, len(truth), "Classification scores")
    if len(set(truth)) < 2:
        return {"scoreProvenance": provenance, "ranking": unavailable("Only one observed class."),
                "thresholdSweep": unavailable("Only one observed class."),
                "calibration": unavailable("Only one observed class.")}
    fpr, tpr, thresholds = roc_curve(truth, values, drop_intermediate=False)
    bacc = (tpr + 1 - fpr) / 2
    best = int(np.argmax(bacc))
    from sklearn.metrics import balanced_accuracy_score
    default = 0.5 if provenance["kind"] == "probability" else 0.0
    result = {
        "scoreProvenance": provenance,
        "ranking": {"available": True, "rocAuc": float(roc_auc_score(truth, values)),
                    "averagePrecision": float(average_precision_score(truth, values)),
                    "positivePrevalence": float(np.mean(truth))},
        "thresholdSweep": {"available": True, "advisory": True, "selectedOnEvaluationRows": True,
                           "defaultThreshold": default,
                           "defaultBalancedAccuracy": float(balanced_accuracy_score(truth, values >= default)),
                           "predictionBalancedAccuracy": float(balanced_accuracy_score(truth, predicted)),
                           "bestBalancedAccuracy": float(bacc[best]),
                           "bestThreshold": float(thresholds[best]) if np.isfinite(thresholds[best]) else None,
                           "bestThresholdAboveMaximum": bool(not np.isfinite(thresholds[best]))},
        "calibration": unavailable("Decision margins are not probabilities."),
    }
    if provenance["kind"] == "probability":
        if np.any((values < 0) | (values > 1)):
            raise ValueError("Probabilities must be in [0, 1]")
        bins = []
        assignment = np.minimum((values * 10).astype(int), 9)
        for index in range(10):
            mask = assignment == index
            bins.append({"lower": index / 10, "upper": (index + 1) / 10, "rows": int(mask.sum()),
                         "meanProbability": float(np.mean(values[mask])) if np.any(mask) else None,
                         "observedPositiveFraction": float(np.mean(np.asarray(truth)[mask])) if np.any(mask) else None})
        result["calibration"] = {"available": True, "brierScore": float(brier_score_loss(truth, values)),
                                 "logLoss": float(log_loss(truth, values, labels=[0, 1])), "bins": bins,
                                 "lossesMeasureCalibrationAndDiscrimination": True}
    return result


def clustering(truth: Sequence[Any] | None, predicted: Sequence[int]) -> dict[str, Any]:
    labels, counts = np.unique(predicted, return_counts=True)
    noise = int(np.sum(np.asarray(predicted) == -1))
    assigned = [int(n) for label, n in zip(labels, counts) if label != -1]
    structure = {"rows": len(predicted), "clusterCount": len(assigned), "noiseRows": noise,
                 "noiseFraction": noise / len(predicted), "assignedFraction": 1 - noise / len(predicted),
                 "clusterSizes": {str(label): int(n) for label, n in zip(labels, counts) if label != -1},
                 "singletonFraction": sum(n == 1 for n in assigned) / len(predicted),
                 "largestClusterShare": max(assigned, default=0) / len(predicted)}
    result = {"structure": structure, "external": unavailable("No family targets supplied.")}
    if truth is not None:
        homogeneity, completeness, v = homogeneity_completeness_v_measure(truth, predicted)
        pairs = pair_confusion_matrix(truth, predicted)
        tn, fp, fn, tp = (int(value) // 2 for value in pairs.ravel())
        contingency = contingency_matrix(truth, predicted, sparse=True).tocoo()
        dense = contingency.shape[0] * contingency.shape[1] <= 4096
        result["external"] = {"available": True, "adjustedRandIndex": float(adjusted_rand_score(truth, predicted)),
                              "homogeneity": float(homogeneity), "completeness": float(completeness), "vMeasure": float(v),
                              "observedFamilies": len(np.unique(truth)), "singleFamilyBatch": len(np.unique(truth)) == 1,
                              "pairPrecision": tp / (tp + fp) if tp + fp else None,
                              "pairRecall": tp / (tp + fn) if tp + fn else None,
                              "pairConfusion": {"trueSame": tp, "falseMerge": fp, "falseSplit": fn, "trueDifferent": tn},
                              "families": [str(value) for value in np.unique(truth)],
                              "clusters": [int(value) for value in labels],
                              "contingency": contingency.toarray().tolist() if dense else None,
                              "contingencySparse": None if dense else [[int(r), int(c), int(n)] for r, c, n in zip(contingency.row, contingency.col, contingency.data)],
                              "noisePolicy": "Noise label -1 is one cluster in external scores; no rows excluded."}
    return result


def anomaly(scores: Sequence[float], predicted: Sequence[int] | None, *,
            direction: str, anomaly_label: int) -> dict[str, Any]:
    values = finite_vector(scores, len(scores), "Anomaly scores")
    oriented = values if direction == "higher_is_anomalous" else -values
    sensitivity = []
    for quantile in (0.5, 0.9, 0.95, 0.99):
        threshold = float(np.quantile(oriented, quantile))
        scale = float(np.quantile(oriented, 0.75) - np.quantile(oriented, 0.25))
        window = scale * 0.01
        sensitivity.append({"quantile": quantile, "orientedThreshold": threshold,
                            "anomalyRows": int(np.sum(oriented >= threshold)),
                            "belowWindowRows": int(np.sum(oriented >= threshold - window)),
                            "aboveWindowRows": int(np.sum(oriented >= threshold + window)),
                            "nearThresholdRows": int(np.sum(np.abs(oriented - threshold) <= window)),
                            "window": window})
    return {"proxyEvidence": True, "scoreDirection": direction,
            "scoreQuantiles": {str(q): float(np.quantile(values, q)) for q in (0, .01, .25, .5, .75, .99, 1)},
            "tieFraction": 1 - len(np.unique(values)) / len(values), "constantScores": bool(np.ptp(values) == 0),
            "predictedAnomalyFraction": float(np.mean(np.asarray(predicted) == anomaly_label)) if predicted is not None else None,
            "thresholdSensitivity": {"available": True, "advisory": True, "rule": "score quantiles; window = 1% of IQR",
                                     "points": sensitivity}}


def stability(rows: Sequence[dict[str, Any]], kind: str, direction: str = "higher_is_anomalous") -> dict[str, Any]:
    batches: dict[tuple[int, int], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        batch = batches[(int(row["repeat"]), int(row["fold"]))]
        if row["id"] in batch:
            raise ValueError("Duplicate observation ID within a validation batch")
        batch[row["id"]] = row
    comparisons = []
    eligible = 0
    # Bounded, deterministic diagnostic sampling; retain declared scope explicitly.
    for (left_key, left), (right_key, right) in combinations(sorted(batches.items()), 2):
        if left_key[0] == right_key[0]:
            continue
        common = sorted(left.keys() & right.keys())
        if len(common) < 2:
            continue
        eligible += 1
        if len(comparisons) >= 100:
            continue
        sampled = common[:10000]
        entry = {"left": list(left_key), "right": list(right_key), "commonRows": len(common), "measuredRows": len(sampled)}
        if kind == "clustering":
            entry["adjustedRandIndex"] = float(adjusted_rand_score(
                [left[key]["prediction"] for key in sampled], [right[key]["prediction"] for key in sampled]))
        else:
            a = finite_vector([left[key]["score"] for key in sampled], len(sampled), "Left scores")
            b = finite_vector([right[key]["score"] for key in sampled], len(sampled), "Right scores")
            constant = bool(np.ptp(a) == 0 or np.ptp(b) == 0)
            entry["spearman"] = None if constant else float(spearmanr(a, b).statistic)
            entry["kendall"] = None if constant else float(kendalltau(a, b).statistic)
            sign = 1 if direction == "higher_is_anomalous" else -1
            order_a, order_b = np.argsort(-sign * a, kind="stable"), np.argsort(-sign * b, kind="stable")
            overlaps = []
            for fraction in (.01, .05, .1):
                k = max(1, int(np.ceil(len(sampled) * fraction)))
                selected_a, selected_b = set(order_a[:k]), set(order_b[:k])
                boundary_ties = int(np.sum(a == a[order_a[k-1]])) > 1 or int(np.sum(b == b[order_b[k-1]])) > 1
                overlaps.append({"fraction": fraction, "k": k, "jaccard": len(selected_a & selected_b) / len(selected_a | selected_b),
                                 "boundaryTies": boundary_ties})
            entry["topAnomalyOverlap"] = overlaps
        comparisons.append(entry)
    if not comparisons:
        return unavailable("Need observations from different repeats with at least two common sample IDs.")
    field = "adjustedRandIndex" if kind == "clustering" else "spearman"
    return {"available": True, "proxyEvidence": True, "eligibleComparisons": eligible,
            "measuredComparisons": len(comparisons), "sampleRule": "first 100 batch pairs and first 10000 common IDs in sorted order",
            "summary": spread([entry[field] for entry in comparisons if entry[field] is not None]),
            "comparisons": comparisons}


def summary(kind: str, folds: Sequence[dict[str, Any]], rows: Sequence[dict[str, Any]],
            direction: str = "higher_is_anomalous") -> dict[str, Any]:
    metric = "adjustedRandIndex" if kind == "clustering" else "balancedAccuracy"
    result = {"schemaVersion": 1, "kind": kind, "scope": "completed validation batches",
              "uniqueRows": len({row["id"] for row in rows}), "observations": len(rows),
              "primaryMetric": metric if any(metric in fold["metrics"] for fold in folds) else None,
              "foldSpread": spread([fold["metrics"][metric] for fold in folds if metric in fold["metrics"]]),
              "fitSeconds": sum(fold.get("fitSeconds", fold["durationSeconds"]) for fold in folds),
              "reachedLimit": any(fold.get("convergence", {}).get("reachedLimit", False) for fold in folds),
              "folds": [{"repeat": fold["repeat"], "fold": fold["fold"], "metrics": fold["metrics"],
                         **({"searchObjective": fold["searchObjective"]} if "searchObjective" in fold else {}),
                         "diagnostics": fold.get("diagnostics", {})} for fold in folds],
              "foldSpreadIsConfidenceInterval": False}
    if kind != "classification":
        result["stability"] = stability(rows, kind, direction)
        result["proxyEvidence"] = result["primaryMetric"] is None
    else:
        result["ranking"] = {
            key: spread([fold["diagnostics"]["ranking"][key] for fold in folds
                         if fold.get("diagnostics", {}).get("ranking", {}).get("available")])
            for key in ("rocAuc", "averagePrecision")}
        result["rankingAggregation"] = "per-fold scores; no pooling of different fitted score scales"
    return result
