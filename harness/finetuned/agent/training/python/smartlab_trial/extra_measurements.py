"""Opt-in measurements execute only under the owning training worker."""
import time
from typing import Any

import numpy as np
from sklearn.base import clone

from .agent_code import _inject_random_states
from .artifacts import EventWriter
from .convergence import capture_convergence_warnings, summarise_convergence
from .diagnostics import finite_vector, unavailable
from .geometry import measure, prediction_strength
from .invocation import InvocationError
from .measurement import kind
from .seeds import _derive_seed
from . import anomaly_measurements
from .diagnostics import anomaly
from scipy.stats import spearmanr
from . import validation_measurements


def run(invocation: Any, estimator: Any, fold: Any, train: Any, validation: Any,
        predictions: list[int] | None, validation_y: Any, raw_scores: Any = None,
        evidence: dict[str, Any] | None = None, estimator_seed: int | None = None,
        train_y: Any = None, provenance: Any = None) -> tuple[dict[str, Any], float]:
    options = invocation.request.get("diagnostics", {})
    signals, fit_seconds = {}, 0.0
    if "representation" in options:
        signals["geometry"] = measure(estimator, validation, predictions if kind(invocation) == "clustering" else None,
                                      options["representation"], _derive_seed("geometry", [fold.seed]))
    if options.get("predictionStrength"):
        if kind(invocation) != "clustering" or invocation.measurement["execution"] != "inductive":
            signals["predictionStrength"] = unavailable("Prediction strength requires inductive clustering; choose a prediction-capable model for this diagnostic")
        else:
            events = EventWriter(invocation.output_dir, invocation.experiment_id)
            seed = _derive_seed("prediction-strength", [fold.seed])
            try:
                independent = clone(estimator)
                _inject_random_states(independent, seed)
                started = time.monotonic()
                events.emit("diagnostic_fit_started", diagnostic="prediction_strength", repeat=fold.repeat, fold=fold.fold,
                            seed=seed, fitRows=len(validation), targetsPassed=False)
                try:
                    with capture_convergence_warnings() as raised:
                        if callable(getattr(independent, "fit_predict", None)):
                            reference = independent.fit_predict(validation)
                        else:
                            independent.fit(validation)
                            reference = independent.predict(validation)
                    labels = finite_vector(reference, len(validation), "Reference partition")
                    if np.any(labels != np.floor(labels)):
                        raise ValueError("Reference partition must contain integer labels")
                    signals["predictionStrength"] = {**prediction_strength(labels.astype(int).tolist(), predictions),
                                                      "seed": seed, "fitRows": len(validation),
                                                      "convergence": summarise_convergence(independent, raised)}
                finally:
                    fit_seconds = time.monotonic() - started
                    events.emit("diagnostic_fit_finished", diagnostic="prediction_strength", repeat=fold.repeat, fold=fold.fold,
                                fitSeconds=fit_seconds, available=signals.get("predictionStrength", {}).get("available", False))
            except Exception as error:
                signals["predictionStrength"] = unavailable(f"{type(error).__name__}: {error}")
    signals.update(anomaly_measurements.read_only(invocation, estimator, fold, train, validation, raw_scores, predictions, evidence))
    if "contamination" in options:
        measured, extra_seconds = contamination(invocation, estimator, fold, train, validation,
                                                predictions, raw_scores, options["contamination"], estimator_seed)
        signals["contamination"] = measured
        fit_seconds += extra_seconds
    validation_signals, extra_seconds = validation_measurements.run(invocation, estimator, fold, train, train_y,
                                                                   validation, validation_y, predictions, raw_scores,
                                                                   evidence, estimator_seed, provenance)
    signals.update(validation_signals)
    return signals, fit_seconds + extra_seconds


def contamination(invocation: Any, estimator: Any, fold: Any, train: Any, validation: Any,
                  baseline_predictions: Any, baseline_scores: Any, option: dict[str, Any], seed: int) -> tuple[dict[str, Any], float]:
    if kind(invocation) != "anomaly_detection":
        return unavailable("Contamination diagnostic requires anomaly_detection"), 0.0
    spec = invocation.measurement
    batch = spec["execution"] == "batch"
    events = EventWriter(invocation.output_dir, invocation.experiment_id)
    points, seconds = [], 0.0
    parameters = estimator.get_params(deep=True)
    for value in option["values"]:
        started, fitting = None, False
        try:
            reused = parameters.get(option["parameter"]) == value
            candidate = estimator if reused else clone(estimator).set_params(**{option["parameter"]: value})
            if not reused:
                _inject_random_states(candidate, seed)
                started, fitting = time.monotonic(), True
                events.emit("diagnostic_fit_started", diagnostic="contamination", repeat=fold.repeat, fold=fold.fold,
                            parameter=option["parameter"], value=value, seed=seed,
                            fitRows=len(validation) if batch else len(train), targetsPassed=False)
                with capture_convergence_warnings() as raised:
                    if batch and callable(getattr(candidate, "fit_predict", None)):
                        predicted = candidate.fit_predict(validation)
                    else:
                        candidate.fit(validation if batch else train)
                        predicted = candidate.predict(validation) if callable(getattr(candidate, "predict", None)) else None
                measured_seconds = time.monotonic() - started
                seconds += measured_seconds
                events.emit("diagnostic_fit_finished", diagnostic="contamination", repeat=fold.repeat, fold=fold.fold,
                            value=value, fitSeconds=measured_seconds, available=True)
                fitting = False
            else:
                predicted = baseline_predictions
            observed = anomaly_measurements.scores(candidate, validation, spec)
            if predicted is not None:
                labels = finite_vector(predicted, len(validation), "Contamination predictions")
                if np.any(labels != np.floor(labels)):
                    raise ValueError("Contamination predictions must be integer labels")
                predicted = labels.astype(int).tolist()
            constant = np.ptp(observed) == 0 or np.ptp(baseline_scores) == 0
            points.append({"value": value, "available": True, "reusedPrimaryFit": reused,
                           "scoreRankSpearman": None if constant else float(spearmanr(observed, baseline_scores).statistic),
                           "predictionChangedFraction": float(np.mean(np.asarray(predicted) != baseline_predictions)) if predicted is not None and baseline_predictions is not None else None,
                           "signals": anomaly(observed, predicted, direction=spec["scoreDirection"], anomaly_label=spec["anomalyLabel"]),
                           **({"convergence": summarise_convergence(candidate, raised)} if not reused else {})})
        except Exception as error:
            if fitting:
                measured_seconds = time.monotonic() - started
                seconds += measured_seconds
                events.emit("diagnostic_fit_finished", diagnostic="contamination", repeat=fold.repeat, fold=fold.fold,
                            value=value, fitSeconds=measured_seconds, available=False)
            points.append({"value": value, **unavailable(f"{type(error).__name__}: {error}")})
    return {"available": any(point["available"] for point in points), "proxyEvidence": True,
            "parameter": option["parameter"], "sameSeedAsPrimaryFit": seed,
            "points": points, "fitSeconds": seconds, "primaryModelUnchanged": True}, seconds


def proxy_score(invocation: Any, estimator: Any, validation: Any, validation_y: Any,
                signals: dict[str, Any]) -> dict[str, Any] | None:
    objective = invocation.search.objective if invocation.search else None
    if objective is None:
        return None
    if objective["metric"] == "estimator_score":
        function = getattr(estimator, "score", None)
        if not callable(function):
            raise InvocationError("Explicit estimator_score objective requires score()")
        value = function(validation, validation_y) if kind(invocation) == "classification" else function(validation)
        array = np.asarray(value, dtype=float)
        if array.ndim != 0 or not np.isfinite(array):
            raise InvocationError("Estimator search score must be one finite scalar")
        raw = float(array)
    elif objective["metric"].startswith("evidence_"):
        key = "rocAuc" if objective["metric"] == "evidence_roc_auc" else "averagePrecision"
        measured = signals.get("evidence", {}).get("ranking", {})
        if not measured.get("available"):
            raise InvocationError("Evidence search objective needs both labelled classes in each measured validation batch")
        raw = measured[key]
    else:
        measured = signals.get("geometry", {}).get(objective["metric"], {})
        if not measured.get("available") or not np.isfinite(measured.get("value", np.nan)):
            raise InvocationError(f"Requested proxy objective unavailable: {objective['metric']}")
        raw = measured["value"]
    return {**objective, "proxyEvidence": True, "rawValue": raw,
            "value": raw if objective["direction"] == "maximize" else -raw}
