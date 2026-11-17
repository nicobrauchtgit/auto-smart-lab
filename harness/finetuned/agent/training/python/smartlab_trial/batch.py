"""Shared target-free anchored clustering fit and bounded test agreement."""
import itertools
import numpy as np
import pandas as pd
from sklearn.metrics import adjusted_rand_score
from .measurement import load_samples
from .invocation import InvocationError
from .diagnostics import finite_vector

MAX_AGREEMENT_PAIRS = 256


def load_anchor(config, labelled=None):
    if not config.get("anchorManifestPath"):
        return None
    anchor, targets, _ = load_samples({"kind": "clustering", "execution": "batch", "hasTargets": False,
        "sampleManifestPath": config["anchorManifestPath"], "sampleManifestSha256": config["anchorManifestSha256"]})
    if targets is not None or (labelled is not None and set(anchor["id"]) & set(labelled["id"])):
        raise InvocationError("Anchor must be target-free and disjoint from labelled rows")
    return anchor


def batch_fit_predict(estimator, labelled_frame, anchor_frame):
    for frame in (labelled_frame, anchor_frame):
        if set(frame.columns) != {"id", "input"}:
            raise InvocationError("Batch fits accept only IDs and input descriptors")
    batch = pd.concat([labelled_frame, anchor_frame], ignore_index=True)
    batch.attrs.clear()
    if batch["id"].duplicated().any():
        raise InvocationError("Batch IDs must be unique")
    if callable(getattr(estimator, "fit_predict", None)):
        raw = estimator.fit_predict(batch)
    else:
        estimator.fit(batch)
        raw = estimator.predict(batch)
    values = finite_vector(raw, len(batch), "Batch predictions")
    if np.any(values != np.floor(values)):
        raise InvocationError("Predictions must be integer labels")
    values = values.astype(int).tolist()
    return values[:len(labelled_frame)], values[len(labelled_frame):]


def test_agreement(folds):
    vectors = [fold["anchorPredictions"] for fold in folds if "anchorPredictions" in fold]
    pairs = list(itertools.islice(itertools.combinations(vectors, 2), MAX_AGREEMENT_PAIRS))
    if not pairs:
        return {"available": False, "reason": "At least two anchored fits are required", "comparisons": 0}
    scores = [float(adjusted_rand_score(a, b)) for a, b in pairs]
    return {"available": True, "meanAdjustedRandIndex": float(np.mean(scores)),
            "minAdjustedRandIndex": min(scores), "comparisons": len(scores)}
