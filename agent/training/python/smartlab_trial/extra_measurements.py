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


def run(invocation: Any, estimator: Any, fold: Any, train: Any, validation: Any,
        predictions: list[int] | None, validation_y: Any) -> tuple[dict[str, Any], float]:
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
    return signals, fit_seconds


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
    else:
        measured = signals.get("geometry", {}).get(objective["metric"], {})
        if not measured.get("available") or not np.isfinite(measured.get("value", np.nan)):
            raise InvocationError(f"Requested proxy objective unavailable: {objective['metric']}")
        raw = measured["value"]
    return {**objective, "proxyEvidence": True, "rawValue": raw,
            "value": raw if objective["direction"] == "maximize" else -raw}
