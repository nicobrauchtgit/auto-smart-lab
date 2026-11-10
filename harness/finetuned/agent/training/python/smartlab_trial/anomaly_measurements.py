"""Evidence provenance and bounded anomaly diagnostics from fitted models."""
import hashlib
import json
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score, roc_curve
from sklearn.pipeline import Pipeline

from .diagnostics import finite_vector, unavailable, spread
from .geometry import dense_features, representation
from .metrics import _measure
from .seeds import _derive_seed


def scores(estimator: Any, frame: Any, spec: dict[str, Any]) -> np.ndarray:
    output = getattr(estimator, spec["scoreMethod"], None)
    if spec["scoreMethod"] != "negative_outlier_factor_" and callable(output):
        output = output(frame)
    elif spec["scoreMethod"] != "negative_outlier_factor_":
        raise ValueError("Declared anomaly score method unavailable")
    return finite_vector(output, len(frame), "Anomaly scores")


def vector_summary(values: Any, rows: int) -> dict[str, Any]:
    values = finite_vector(values, rows, "Model diagnostic values")
    return {**spread(values.tolist()), "quantiles": {str(q): float(np.quantile(values, q)) for q in (0, .05, .5, .95, 1)}}


def labelled(truth: list[int], raw_scores: Any, predictions: list[int] | None,
             direction: str, anomaly_label: int) -> dict[str, Any]:
    values = finite_vector(raw_scores, len(truth), "Evidence scores")
    oriented = values if direction == "higher_is_anomalous" else -values
    result = {"rows": len(truth), "positiveRows": sum(truth), "positivePrevalence": float(np.mean(truth)),
              "ranking": unavailable("Both evidence classes are required"),
              "predictionMetrics": unavailable("Predictions unavailable" if predictions is None else "Both evidence classes are required")}
    if len(set(truth)) == 2:
        from .uncertainty import operating_points
        result["lowFpr"] = operating_points(truth, oriented,
                                            [int(label == anomaly_label) for label in predictions] if predictions is not None else None)
        result["ranking"] = {"available": True, "rocAuc": float(roc_auc_score(truth, oriented)),
                             "averagePrecision": float(average_precision_score(truth, oriented))}
        fpr, tpr, thresholds = roc_curve(truth, oriented, drop_intermediate=False)
        best = int(np.argmax((tpr + 1 - fpr) / 2))
        result["thresholdSweep"] = {"available": True, "advisory": True, "selectedOnEvaluationRows": True,
                                    "bestBalancedAccuracy": float((tpr[best] + 1 - fpr[best]) / 2),
                                    "orientedThreshold": float(thresholds[best]) if np.isfinite(thresholds[best]) else None,
                                    "thresholdAboveMaximum": bool(not np.isfinite(thresholds[best]))}
        if predictions is not None:
            result["predictionMetrics"] = {"available": True, **_measure(truth, [int(label == anomaly_label) for label in predictions])}
    return result


def evidence(frame: Any, raw_scores: Any, predictions: list[int] | None, metadata: dict[str, Any] | None,
             spec: dict[str, Any]) -> dict[str, Any]:
    if not metadata:
        return unavailable("No diagnostic evidence labels supplied")
    labels = metadata["labels"]
    indices = [i for i, row_id in enumerate(frame.id) if row_id in labels]
    result = {"source": metadata["source"], "manifestSha256": metadata["sha256"],
              "proxyEvidence": metadata["source"] != "trusted", "validationRows": len(frame),
              "labelledRows": len(indices), "labelCoverage": len(indices) / len(frame), "promotionEvidence": False}
    if not indices:
        return {**result, **unavailable("No evidence labels in this validation batch")}
    measured = labelled([labels[frame.id.iloc[i]] for i in indices], np.asarray(raw_scores)[indices],
                        [predictions[i] for i in indices] if predictions is not None else None,
                        spec["scoreDirection"], spec["anomalyLabel"])
    return {"available": True, **result, **measured, "promotionEvidence": bool(spec.get("selection")) and measured["ranking"]["available"]}


def model_signals(estimator: Any, train: Any, validation: Any, option: dict[str, Any], seed: int,
                  batch: bool) -> dict[str, Any]:
    function = getattr(estimator, option["method"], None)
    if not callable(function):
        return unavailable("Declared model-signal method unavailable")
    def sample(frame):
        indices = np.sort(np.random.default_rng(seed).choice(len(frame), min(len(frame), option.get("maxRows", 512)), replace=False))
        return frame.iloc[indices].reset_index(drop=True)
    def read(frame):
        outputs = function(frame)
        if not isinstance(outputs, dict) or not outputs or set(outputs) - {"reconstructionError", "logLikelihood"}:
            raise ValueError("Model signals must contain reconstructionError and/or logLikelihood vectors")
        result = {}
        for name, vector in outputs.items():
            values = finite_vector(vector, len(frame), name)
            if name == "reconstructionError" and np.any(values < 0):
                raise ValueError("Reconstruction errors cannot be negative")
            result[name] = vector_summary(values, len(frame))
        return result
    try:
        val = sample(validation)
        result = {"available": True, "proxyEvidence": True, "method": option["method"], "units": option.get("units"),
                  "validationRows": len(val), "validation": read(val), "seed": seed}
        if option.get("compareTrain"):
            if batch:
                result["trainComparison"] = unavailable("Batch execution has no independently fitted training population")
            else:
                training = sample(train)
                try:
                    measured = read(training)
                    result["trainComparison"] = {"available": True, "rows": len(training), "resubstitution": True,
                                                  "training": measured,
                                                  "validationMinusTrainingMean": {name: result["validation"][name]["mean"] - measured[name]["mean"]
                                                                                 for name in set(measured) & set(result["validation"])}}
                except Exception as error:
                    result["trainComparison"] = unavailable(f"{type(error).__name__}: {error}")
        return result
    except Exception as error:
        return unavailable(f"{type(error).__name__}: {error}")


def volume_curves(observed: Any, reference: Any, support_volume: float, direction: str) -> dict[str, Any]:
    observed = finite_vector(observed, len(observed), "Observed volume scores")
    reference = finite_vector(reference, len(reference), "Uniform reference scores")
    if support_volume <= 0 or not np.isfinite(support_volume):
        raise ValueError("Support volume must be positive and finite")
    # Curves use high normality levels, opposite to high anomaly scores.
    sign = -1 if direction == "higher_is_anomalous" else 1
    a, b = np.sort(sign * observed), np.sort(sign * reference)
    mass_volume = []
    for level in (.5, .9, .95, .99):
        threshold = a[-max(1, int(np.ceil(level * len(a))))]
        mass = (len(a) - np.searchsorted(a, threshold, side="left")) / len(a)
        fraction = (len(b) - np.searchsorted(b, threshold, side="left")) / len(b)
        mass_volume.append({"targetMass": level, "actualMass": float(mass), "normalityThreshold": float(threshold),
                            "volume": float(support_volume * fraction),
                            "monteCarloStandardError": float(support_volume * np.sqrt(fraction * (1 - fraction) / len(b)))})
    thresholds = np.unique(np.concatenate([a, b]))
    masses = (len(a) - np.searchsorted(a, thresholds, side="left")) / len(a)
    volumes = support_volume * (len(b) - np.searchsorted(b, thresholds, side="left")) / len(b)
    t_grid = np.linspace(0, 1 / support_volume, 51)
    excess = np.maximum(0, np.max(masses[None, :] - t_grid[:, None] * volumes[None, :], axis=1))
    area = float(np.sum((excess[1:] + excess[:-1]) / 2 * np.diff(t_grid)))
    return {"available": True, "proxyEvidence": True, "supportVolume": support_volume,
            "observedRows": len(a), "uniformRows": len(b), "massVolume": mass_volume,
            "excessMass": [{"t": float(t), "value": float(value)} for t, value in zip(t_grid, excess)],
            "excessMassArea": area, "areaRange": [0, float(1 / support_volume)],
            "constantObservedScores": bool(a[0] == a[-1]), "monteCarlo": True}


def volume(estimator: Any, frame: Any, raw_scores: Any, rep: dict[str, Any], option: dict[str, Any],
           spec: dict[str, Any], seed: int) -> dict[str, Any]:
    try:
        indices = np.sort(np.random.default_rng(seed).choice(len(frame), min(len(frame), rep.get("maxRows", 512)), replace=False))
        features = dense_features(representation(estimator, frame.iloc[indices].reset_index(drop=True), rep), len(indices))
        bounds = np.asarray(option["bounds"], dtype=float)
        if features.shape[1] != len(bounds):
            raise ValueError("Volume bounds do not match representation dimensions")
        if np.any((features < bounds[:, 0]) | (features > bounds[:, 1])):
            raise ValueError("Declared volume support does not cover observed diagnostic features")
        if option["scoreSource"] == "pipeline_model":
            if not isinstance(estimator, Pipeline) or rep["source"] != "pipeline_features" or option["scoreMethod"] != spec["scoreMethod"]:
                raise ValueError("pipeline_model must match the fitted prefix and declared anomaly scoring method")
            function = getattr(estimator[-1], option["scoreMethod"], None)
        else:
            function = getattr(estimator, option["scoreMethod"], None)
        if not callable(function):
            raise ValueError("Feature-space scoring method unavailable")
        observed = finite_vector(function(features), len(indices), "Feature scores")
        if not np.allclose(observed, np.asarray(raw_scores)[indices], rtol=1e-6, atol=1e-9):
            raise ValueError("Feature-space scoring does not reproduce the authoritative validation scores")
        uniform = np.random.default_rng(seed).uniform(bounds[:, 0], bounds[:, 1], (option.get("uniformSamples", 2048), len(bounds)))
        reference = finite_vector(function(uniform), len(uniform), "Uniform scores")
        with np.errstate(over="ignore", invalid="ignore"):
            support = float(np.prod(bounds[:, 1] - bounds[:, 0]))
        return {**volume_curves(observed, reference, support, spec["scoreDirection"]),
                "bounds": bounds.tolist(), "dimensions": len(bounds), "seed": seed,
                "scoreSource": option["scoreSource"], "scoreMethod": option["scoreMethod"],
                "supportCaveat": "Conditional on declared feature space and support; not real anomaly accuracy"}
    except Exception as error:
        return unavailable(f"{type(error).__name__}: {error}")


def challenge(estimator: Any, frame: Any, option: dict[str, Any], spec: dict[str, Any], seed: int) -> dict[str, Any]:
    if spec["scoreMethod"] == "negative_outlier_factor_":
        return unavailable("Fitted-row score attributes cannot score a new challenge population")
    try:
        function = getattr(estimator, option["method"], None)
        if not callable(function):
            raise ValueError("Declared challenge method unavailable")
        maximum = option.get("maxRows", 512)
        indices = np.sort(np.random.default_rng(seed).choice(len(frame), min(len(frame), maximum), replace=False))
        outputs = function(frame.iloc[indices].reset_index(drop=True).copy(), {"seed": seed, "maxRows": maximum})
        if not isinstance(outputs, dict) or set(outputs) != {"frame", "labels"}:
            raise ValueError("Challenge must return frame and binary anomaly labels")
        data = outputs["frame"]
        if (not isinstance(data, pd.DataFrame) or not 2 <= len(data) <= maximum or list(data.columns) != list(frame.columns)
                or not all(isinstance(row_id, str) and row_id for row_id in data.id) or data.id.duplicated().any()):
            raise ValueError("Challenge requires bounded rows, matching columns and unique string IDs")
        data = data.reset_index(drop=True)
        data.attrs.clear()
        truth = finite_vector(outputs["labels"], len(data), "Challenge labels")
        if np.any((truth != 0) & (truth != 1)):
            raise ValueError("Challenge labels must be binary with 1 anomalous")
        observed = scores(estimator, data, spec)
        predicted = None
        if callable(getattr(estimator, "predict", None)):
            values = finite_vector(estimator.predict(data), len(data), "Challenge predictions")
            if np.any(values != np.floor(values)):
                raise ValueError("Challenge predictions must be integer labels")
            predicted = values.astype(int).tolist()
        digest = hashlib.sha256(json.dumps({"rows": data.to_dict("records"), "labels": truth.tolist()}, sort_keys=True).encode()).hexdigest()
        return {"available": True, "proxyEvidence": True, "source": "synthetic", "promotionEvidence": False,
                "method": option["method"], "seed": seed, "contentSha256": digest,
                **labelled(truth.astype(int).tolist(), observed, predicted, spec["scoreDirection"], spec["anomalyLabel"])}
    except Exception as error:
        return unavailable(f"{type(error).__name__}: {error}")


def read_only(invocation: Any, estimator: Any, fold: Any, train: Any, validation: Any,
              raw_scores: Any, predictions: list[int] | None, metadata: dict[str, Any] | None) -> dict[str, Any]:
    options = invocation.request.get("diagnostics", {})
    signals = {}
    batch = invocation.measurement is not None and invocation.measurement["execution"] == "batch"
    if "modelSignals" in options:
        signals["modelSignals"] = model_signals(estimator, train, validation, options["modelSignals"],
                                               _derive_seed("model-signals", [fold.seed]), batch)
    if invocation.measurement and invocation.measurement["kind"] == "anomaly_detection":
        spec = invocation.measurement
        signals["evidence"] = evidence(validation, raw_scores, predictions, metadata, spec)
        if "volume" in options:
            signals["volume"] = volume(estimator, validation, raw_scores, options["representation"], options["volume"],
                                       spec, _derive_seed("volume", [fold.seed]))
        if "challenge" in options:
            signals["challenge"] = challenge(estimator, validation, options["challenge"], spec, _derive_seed("challenge", [fold.seed]))
    else:
        for key in ("volume", "challenge"):
            if key in options:
                signals[key] = unavailable("This diagnostic requires anomaly_detection")
    return signals
