"""Optional slice, learning and perturbation measurements under harness ownership."""
import hashlib
import json
import time
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.base import clone
from sklearn.metrics import adjusted_rand_score

from .agent_code import _inject_random_states
from .anomaly_measurements import evidence, scores as anomaly_scores
from .artifacts import EventWriter
from .convergence import capture_convergence_warnings, summarise_convergence
from .diagnostics import anomaly, classification, clustering, finite_vector, unavailable
from .measurement import kind
from .metrics import _measure, score_observation
from .seeds import _derive_seed


def _labels(values: Any, rows: int, binary: bool = False) -> list[int] | None:
    if values is None:
        return None
    vector = finite_vector(values, rows, "Diagnostic predictions")
    if np.any(vector != np.floor(vector)) or (binary and np.any((vector != 0) & (vector != 1))):
        raise ValueError("Diagnostic predictions must have the task's integer label domain")
    return vector.astype(int).tolist()


def _observe(invocation: Any, estimator: Any, frame: Any, fitted_predictions: Any = None) -> tuple[Any, Any, dict[str, Any]]:
    task = kind(invocation)
    predicted = fitted_predictions
    if predicted is None and callable(getattr(estimator, "predict", None)):
        predicted = estimator.predict(frame)
    predicted = _labels(predicted, len(frame), task == "classification")
    if task == "classification":
        values, provenance = score_observation(estimator, frame)
    elif task == "anomaly_detection":
        values, provenance = anomaly_scores(estimator, frame, invocation.measurement), {"kind": "anomaly"}
    else:
        values, provenance = None, {"kind": "partition"}
    return predicted, values, provenance


def _assessment(invocation: Any, frame: Any, truth: Any, predicted: Any, values: Any,
                provenance: dict[str, Any], metadata: dict[str, Any] | None) -> dict[str, Any]:
    task = kind(invocation)
    if task == "classification":
        metrics = _measure(truth, predicted)
        if len(set(truth)) < 2:
            metrics.pop("balancedAccuracy", None)
        return {"metrics": metrics, "diagnostics": classification(truth, predicted, values, provenance),
                "primaryAvailable": "balancedAccuracy" in metrics}
    if task == "clustering":
        signals = clustering(truth, predicted)
        metrics = {"adjustedRandIndex": signals["external"]["adjustedRandIndex"]} if truth is not None else {}
        return {"metrics": metrics, "diagnostics": signals, "primaryAvailable": truth is not None}
    spec = invocation.measurement
    return {"metrics": {}, "primaryAvailable": False,
            "diagnostics": {"anomaly": anomaly(values, predicted, direction=spec["scoreDirection"], anomaly_label=spec["anomalyLabel"]),
                            "evidence": evidence(frame, values, predicted, metadata, spec)}}


def _fit(invocation: Any, estimator: Any, fold: Any, frame: Any, truth: Any, seed: int,
         diagnostic: str, ledger: list[float], batch: bool = False, **details: Any) -> tuple[Any, Any, dict[str, Any]]:
    candidate = clone(estimator)
    seeded = _inject_random_states(candidate, seed)
    frame = frame.copy()
    frame.attrs.clear()
    events = EventWriter(invocation.output_dir, invocation.experiment_id)
    events.emit("diagnostic_fit_started", diagnostic=diagnostic, repeat=fold.repeat, fold=fold.fold,
                seed=seed, fitRows=len(frame), targetsPassed=kind(invocation) == "classification", **details)
    started, completed = time.monotonic(), False
    try:
        with capture_convergence_warnings() as raised:
            predicted = None
            if kind(invocation) == "classification":
                candidate.fit(frame, truth)
            elif batch and callable(getattr(candidate, "fit_predict", None)):
                predicted = candidate.fit_predict(frame)
            else:
                candidate.fit(frame)
        completed = True
        return candidate, predicted, {"seed": seed, "seededParameters": seeded,
                                      "fitRows": len(frame), "convergence": summarise_convergence(candidate, raised)}
    finally:
        seconds = time.monotonic() - started
        ledger[0] += seconds
        events.emit("diagnostic_fit_finished", diagnostic=diagnostic, repeat=fold.repeat, fold=fold.fold,
                    fitSeconds=seconds, available=completed, **details)


def slices(invocation: Any, estimator: Any, validation: Any, truth: Any, predicted: Any, values: Any,
           provenance: dict[str, Any], metadata: Any, option: dict[str, Any]) -> dict[str, Any]:
    try:
        masks = getattr(estimator, option["method"])(validation.copy())
        if not isinstance(masks, dict) or not 1 <= len(masks) <= option.get("maxGroups", 16):
            raise ValueError("Slices must return a bounded dictionary of named Boolean masks")
        groups = []
        for name, mask in masks.items():
            array = np.asarray(mask)
            if not isinstance(name, str) or not 1 <= len(name) <= 100 or array.dtype != bool or array.shape != (len(validation),):
                raise ValueError("Each slice needs a bounded name and a row-aligned Boolean mask")
            indices = np.flatnonzero(array)
            if not len(indices):
                groups.append({"name": name, "rows": 0, **unavailable("Empty slice")})
                continue
            frame = validation.iloc[indices].reset_index(drop=True)
            measured = _assessment(invocation, frame, [truth[i] for i in indices] if truth is not None else None,
                                   [predicted[i] for i in indices] if predicted is not None else None,
                                   np.asarray(values)[indices] if values is not None else None, provenance, metadata)
            groups.append({"name": name, "rows": len(indices), "fraction": len(indices) / len(validation),
                           "available": True, **measured})
        return {"available": True, "advisory": True, "method": option["method"],
                "groupsMayOverlap": True, "validationRows": len(validation), "groups": groups}
    except Exception as error:
        return unavailable(f"{type(error).__name__}: {error}")


def learning_curve(invocation: Any, estimator: Any, fold: Any, train: Any, train_y: Any, validation: Any,
                   validation_y: Any, predicted: Any, values: Any, provenance: Any, metadata: Any,
                   option: dict[str, Any], seed: int) -> tuple[dict[str, Any], float]:
    if invocation.measurement and invocation.measurement["execution"] == "batch":
        return unavailable("A train-only learning curve requires inductive execution; batch discovery has a different fit population"), 0.0
    order_seed = _derive_seed("learning-subsets", [fold.seed])
    order = np.random.default_rng(order_seed).permutation(len(train))
    ledger, points, cache = [0.0], [], {}
    for fraction in sorted(option["fractions"]):
        n = max(1, int(np.ceil(fraction * len(train))))
        try:
            reused = n in cache or n == len(train)
            if n in cache:
                measured, fit_details = cache[n]
            elif n == len(train):
                measured = _assessment(invocation, validation, validation_y, predicted, values, provenance, metadata)
                fit_details = {"reusedPrimaryFit": True, "fitRows": n, "seed": seed}
            else:
                indices = np.sort(order[:n])
                subset = train.iloc[indices].reset_index(drop=True)
                targets = [train_y[i] for i in indices] if train_y is not None else None
                candidate, _, fit_details = _fit(invocation, estimator, fold, subset, targets, seed, "learning_curve", ledger, fraction=fraction)
                p, s, origin = _observe(invocation, candidate, validation)
                measured = _assessment(invocation, validation, validation_y, p, s, origin, metadata)
                fit_details["trainingIdsSha256"] = hashlib.sha256(json.dumps(subset.id.tolist()).encode()).hexdigest()
            cache[n] = measured, fit_details
            points.append({"fraction": fraction, "available": True, "reusedMeasuredFit": reused,
                           "validationRows": len(validation), **fit_details, **measured})
        except Exception as error:
            points.append({"fraction": fraction, "fitRows": n, **unavailable(f"{type(error).__name__}: {error}")})
    return {"available": any(point["available"] for point in points), "advisory": True,
            "validationRows": len(validation), "validationIdsSha256": hashlib.sha256(json.dumps(validation.id.tolist()).encode()).hexdigest(),
            "nestedTrainingSubsets": True, "subsetSeed": order_seed,
            "sameEstimatorSeed": seed, "points": points, "fitSeconds": ledger[0]}, ledger[0]


def _agreement(task: str, original: Any, changed: Any, old_scores: Any, new_scores: Any) -> dict[str, Any]:
    result = {}
    if original is not None and changed is not None:
        if task == "clustering":
            result["partitionAdjustedRandIndex"] = float(adjusted_rand_score(original, changed))
        else:
            result["predictionChangedFraction"] = float(np.mean(np.asarray(original) != changed))
    if old_scores is not None and new_scores is not None:
        constant = np.ptp(old_scores) == 0 or np.ptp(new_scores) == 0
        result["scoreRankSpearman"] = None if constant else float(spearmanr(old_scores, new_scores).statistic)
    return result


def robustness(invocation: Any, estimator: Any, fold: Any, validation: Any, truth: Any, predicted: Any, values: Any,
               provenance: Any, metadata: Any, option: dict[str, Any], seed: int) -> tuple[dict[str, Any], float]:
    ledger = [0.0]
    sample_seed = _derive_seed("robustness-sample", [fold.seed])
    indices = np.sort(np.random.default_rng(sample_seed).choice(len(validation), min(len(validation), option.get("maxRows", 512)), replace=False))
    frame = validation.iloc[indices].reset_index(drop=True)
    targets = [truth[i] for i in indices] if truth is not None else None
    base_p = [predicted[i] for i in indices] if predicted is not None else None
    base_s = np.asarray(values)[indices] if values is not None else None
    batch = invocation.measurement is not None and invocation.measurement["execution"] == "batch"
    try:
        variants = getattr(estimator, option["method"])(frame.copy(), {"seed": sample_seed, "maxRows": len(frame), "maxVariants": option.get("maxVariants", 4)})
        if not isinstance(variants, list) or not 1 <= len(variants) <= option.get("maxVariants", 4):
            raise ValueError("Perturbations must return a bounded list of named frames")
        names = set()
        for variant in variants:
            if (not isinstance(variant, dict) or set(variant) != {"name", "frame", "labelPreserving"}
                    or not isinstance(variant["name"], str) or not 1 <= len(variant["name"]) <= 100
                    or variant["name"] in names or type(variant["labelPreserving"]) is not bool):
                raise ValueError("Perturbations require unique bounded names, frames, and explicit labelPreserving flags")
            names.add(variant["name"])
            data = variant["frame"]
            if (not isinstance(data, pd.DataFrame) or list(data.columns) != list(frame.columns) or data.id.tolist() != frame.id.tolist()):
                raise ValueError("Perturbations must preserve the measured row IDs, order and input columns")
        if batch:
            baseline, fitted, _ = _fit(invocation, estimator, fold, frame, None, seed, "robustness_baseline", ledger, batch=True)
            base_p, base_s, provenance = _observe(invocation, baseline, frame, fitted)
        baseline = _assessment(invocation, frame, targets, base_p, base_s, provenance, metadata)
        measurements = []
        for variant in variants:
            try:
                data = variant["frame"].reset_index(drop=True)
                data.attrs.clear()
                if batch:
                    candidate, fitted, fit_details = _fit(invocation, estimator, fold, data, None, seed, "robustness_variant", ledger, batch=True, variant=variant["name"])
                else:
                    candidate, fitted, fit_details = estimator, None, {"reusedPrimaryFit": True}
                p, s, origin = _observe(invocation, candidate, data, fitted)
                details = {"name": variant["name"], "available": True, "rows": len(data),
                           "labelPreserving": variant["labelPreserving"], "labelAssumptionSource": "agent_declared",
                           "contentSha256": hashlib.sha256(json.dumps(data.to_dict("records"), sort_keys=True).encode()).hexdigest(),
                           "agreement": _agreement(kind(invocation), base_p, p, base_s, s), **fit_details}
                if variant["labelPreserving"]:
                    details.update(_assessment(invocation, data, targets, p, s, origin, metadata))
                else:
                    details["quality"] = unavailable("Changed labels are unknown; agreement only")
                measurements.append(details)
            except Exception as error:
                measurements.append({"name": variant["name"], **unavailable(f"{type(error).__name__}: {error}")})
        return {"available": True, "advisory": True, "method": option["method"], "sampleSeed": sample_seed,
                "sameEstimatorSeed": seed, "validationRows": len(validation), "measuredRows": len(frame),
                "baseline": baseline, "baselineRefittedOnDiagnosticBatch": batch,
                "variants": measurements, "fitSeconds": ledger[0]}, ledger[0]
    except Exception as error:
        return unavailable(f"{type(error).__name__}: {error}"), ledger[0]


def run(invocation: Any, estimator: Any, fold: Any, train: Any, train_y: Any, validation: Any, truth: Any,
        predicted: Any, values: Any, metadata: Any, seed: int, provenance: Any) -> tuple[dict[str, Any], float]:
    options, result, seconds = invocation.request.get("diagnostics", {}), {}, 0.0
    provenance = provenance or {"kind": "unavailable"}
    if "slices" in options:
        result["slices"] = slices(invocation, estimator, validation, truth, predicted, values, provenance, metadata, options["slices"])
    if "learningCurve" in options:
        result["learningCurve"], measured = learning_curve(invocation, estimator, fold, train, train_y, validation, truth,
                                                          predicted, values, provenance, metadata, options["learningCurve"], seed)
        seconds += measured
    if "robustness" in options:
        result["robustness"], measured = robustness(invocation, estimator, fold, validation, truth, predicted, values,
                                                   provenance, metadata, options["robustness"], seed)
        seconds += measured
    return result, seconds
