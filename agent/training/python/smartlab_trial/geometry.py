"""Bounded diagnostics of the agent's fitted representation; no content loader."""
from collections import Counter
from typing import Any

import numpy as np
from scipy import sparse
from scipy.special import logsumexp
from sklearn.metrics import (calinski_harabasz_score, davies_bouldin_score,
                             pairwise_distances, silhouette_samples)
from sklearn.pipeline import Pipeline

from .diagnostics import unavailable, spread


def representation(estimator: Any, frame: Any, spec: dict[str, Any]) -> Any:
    if spec["source"] == "pipeline_features":
        if not isinstance(estimator, Pipeline) or len(estimator.steps) < 2:
            raise ValueError("pipeline_features needs a fitted Pipeline with a feature prefix")
        return estimator[:-1].transform(frame)
    method = getattr(estimator, spec["method"], None)
    if not callable(method):
        raise ValueError("Declared representation method is unavailable")
    return method(frame)


def dense_features(features: Any, rows: int) -> np.ndarray:
    if sparse.issparse(features):
        if features.shape[0] != rows or features.shape[0] * features.shape[1] > 2_000_000:
            raise ValueError("Diagnostic representation exceeds two million cells or has wrong row count")
        features = features.toarray()
    array = np.asarray(features, dtype=float)
    if array.ndim != 2 or array.shape[0] != rows or not array.shape[1] or array.size > 2_000_000:
        raise ValueError("Representation must be a bounded rows-by-features matrix")
    if not np.all(np.isfinite(array)):
        raise ValueError("Representation contains nonfinite values")
    return array


def _mst(distances: np.ndarray) -> list[tuple[int, int, float]]:
    """Deterministic dense Prim; zero-distance edges are retained."""
    n = len(distances)
    used = np.zeros(n, dtype=bool)
    used[0] = True
    best, parent = distances[0].copy(), np.zeros(n, dtype=int)
    edges = []
    for _ in range(n - 1):
        vertex = int(np.argmin(np.where(used, np.inf, best)))
        edges.append((int(parent[vertex]), vertex, float(best[vertex])))
        used[vertex] = True
        improve = (~used) & (distances[vertex] < best)
        best[improve], parent[improve] = distances[vertex, improve], vertex
    return edges


def density_validity(features: np.ndarray, labels: np.ndarray) -> dict[str, Any]:
    """DBCV with all-points core distances and internal mutual-reachability MSTs.

    Euclidean ambient dimension. Noise weight remains in the denominator.
    Degenerate/small clusters are unavailable, rather than silently discarded.
    """
    clusters = [label for label in np.unique(labels) if label != -1]
    if len(clusters) < 2:
        return unavailable("DBCV requires at least two assigned clusters")
    distances = pairwise_distances(features)
    core = np.zeros(len(features))
    nodes, sparseness = {}, {}
    dimension = features.shape[1]
    for label in clusters:
        indices = np.flatnonzero(labels == label)
        if len(indices) < 3:
            return unavailable("DBCV requires three or more rows in every sampled cluster")
        within = distances[np.ix_(indices, indices)]
        # Exact duplicates yield an infinite estimated density (core distance zero).
        for offset, index in enumerate(indices):
            other = np.delete(within[offset], offset)
            core[index] = (0.0 if np.any(other == 0) else float(np.exp(
                -(logsumexp(-dimension * np.log(other)) - np.log(len(other))) / dimension)))
        mutual = np.maximum(np.maximum(within, core[indices, None]), core[None, indices])
        edges = _mst(mutual)
        degree = Counter(vertex for a, b, _ in edges for vertex in (a, b))
        internal = {vertex for vertex, count in degree.items() if count > 1}
        internal_edges = [weight for a, b, weight in edges if a in internal and b in internal]
        if not internal_edges:
            # Small/star trees have no internal edge: use all edges, explicitly recorded.
            internal_edges = [weight for _, _, weight in edges]
        nodes[label], sparseness[label] = indices[sorted(internal)], max(internal_edges)
    validity = []
    for label in clusters:
        separation = np.inf
        for other in clusters:
            if other == label:
                continue
            a, b = nodes[label], nodes[other]
            mutual = np.maximum(np.maximum(distances[np.ix_(a, b)], core[a, None]), core[None, b])
            separation = min(separation, float(np.min(mutual)))
        denominator = max(separation, sparseness[label])
        if not np.isfinite(denominator) or denominator == 0:
            return unavailable("DBCV is undefined for collapsed zero-distance clusters")
        validity.append({"cluster": int(label), "rows": int(np.sum(labels == label)),
                         "validity": float((separation - sparseness[label]) / denominator)})
    return {"available": True, "value": sum(row["validity"] * row["rows"] / len(labels) for row in validity),
            "clusters": validity, "dimension": dimension, "metric": "euclidean",
            "noiseWeightRetained": True, "smallTreePolicy": "all edges when no internal edges exist"}


def measure(estimator: Any, frame: Any, predictions: list[int] | None,
            spec: dict[str, Any], seed: int) -> dict[str, Any]:
    indices = np.sort(np.random.default_rng(seed).choice(len(frame), min(len(frame), spec.get("maxRows", 512)), replace=False))
    result = {"proxyEvidence": True, "source": spec["source"], "method": spec.get("method"),
              "metric": spec.get("metric", "euclidean"), "totalRows": len(frame), "measuredRows": len(indices),
              "sampling": "uniform without replacement, harness seed", "seed": seed}
    try:
        features = dense_features(representation(estimator, frame.iloc[indices].reset_index(drop=True), spec), len(indices))
        variances = np.var(features, axis=0)
        norms = np.linalg.norm(features, axis=1)
        result["embedding"] = {"available": True, "dimensions": features.shape[1],
                               "constantDimensions": int(np.sum(variances == 0)),
                               "zeroNormRows": int(np.sum(norms == 0)), "norms": spread(norms.tolist())}
        if predictions is None:
            return result
        labels = np.asarray(predictions)[indices]
        assigned = labels != -1
        result["assignedRows"] = int(assigned.sum())
        result["noisePolicy"] = "noise excluded from silhouette/CH/DB; full coverage recorded; DBCV retains noise weight"
        if spec.get("dbcv"):
            result["dbcv"] = density_validity(features, labels) if result["metric"] == "euclidean" else unavailable("DBCV requires Euclidean coordinates")
        x, assigned_labels = features[assigned], labels[assigned]
        if not 2 <= len(np.unique(assigned_labels)) < len(x):
            for key in ("silhouette", "calinskiHarabasz", "daviesBouldin"):
                result[key] = unavailable("Need between two and n-1 assigned clusters in the measured sample")
            return result
        values = silhouette_samples(x, assigned_labels, metric=result["metric"])
        result["silhouette"] = {"available": True, **spread(values.tolist()), "value": float(np.mean(values)),
                                "negativeFraction": float(np.mean(values < 0)),
                                "quantiles": {str(q): float(np.quantile(values, q)) for q in (.05, .25, .5, .75, .95)},
                                "perCluster": {str(label): spread(values[assigned_labels == label].tolist()) for label in np.unique(assigned_labels)}}
        if result["metric"] == "euclidean":
            for key, function in (("calinskiHarabasz", calinski_harabasz_score), ("daviesBouldin", davies_bouldin_score)):
                value = float(function(x, assigned_labels))
                result[key] = {"available": bool(np.isfinite(value)), "value": value if np.isfinite(value) else None}
        else:
            for key in ("calinskiHarabasz", "daviesBouldin"):
                result[key] = unavailable("Centroid geometry indices require Euclidean coordinates")
    except (ValueError, TypeError, AttributeError) as error:
        result.update(unavailable(str(error)))
    return result


def prediction_strength(reference: list[int], predicted: list[int]) -> dict[str, Any]:
    clusters = []
    for label in sorted(set(reference)):
        if label == -1:
            continue
        members = [predicted[i] for i, value in enumerate(reference) if value == label]
        n = len(members)
        if n < 2:
            return unavailable("Prediction strength is undefined for singleton reference clusters")
        # Noise predictions represent unassigned rows, never successful co-memberships.
        same = sum(count * (count - 1) for value, count in Counter(members).items() if value != -1)
        clusters.append({"cluster": label, "rows": n, "value": same / (n * (n - 1))})
    return ({"available": True, "proxyEvidence": True, "value": min(row["value"] for row in clusters),
             "clusters": clusters, "referenceNoiseRows": reference.count(-1)} if clusters
            else unavailable("No assigned reference clusters"))
