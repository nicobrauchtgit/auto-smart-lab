"""Validate opt-in measurement requests at the worker boundary."""
import re
from typing import Any
from .invocation import InvocationError

GEOMETRY_METRICS = {"silhouette", "calinskiHarabasz", "daviesBouldin", "dbcv"}
PROXY_METRICS = GEOMETRY_METRICS | {"estimator_score", "evidence_roc_auc", "evidence_average_precision"}


def public_method(value: Any) -> bool:
    return (isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value) is not None
            and value not in {"fit", "fit_predict", "fit_transform", "partial_fit", "set_params"})


def validate_options(request: dict[str, Any]) -> None:
    spec = request.get("diagnostics", {})
    if not isinstance(spec, dict) or set(spec) - {"representation", "predictionStrength", "modelSignals", "challenge", "volume", "contamination", "slices", "robustness", "learningCurve"}:
        raise InvocationError("Invalid diagnostics options")
    if "predictionStrength" in spec and type(spec["predictionStrength"]) is not bool:
        raise InvocationError("diagnostics.predictionStrength must be boolean")
    if "representation" in spec:
        rep = spec["representation"]
        if not isinstance(rep, dict) or set(rep) - {"source", "method", "metric", "maxRows", "dbcv"}:
            raise InvocationError("Invalid representation options")
        if rep.get("source") not in ("pipeline_features", "method"):
            raise InvocationError("Representation requires pipeline_features or method")
        if rep["source"] == "method" and not public_method(rep.get("method")):
            raise InvocationError("Representation requires a public method name")
        if rep["source"] == "pipeline_features" and "method" in rep:
            raise InvocationError("pipeline_features does not accept method")
        if rep.get("metric", "euclidean") not in ("euclidean", "cosine"):
            raise InvocationError("Unsupported diagnostic distance")
        if type(rep.get("maxRows", 512)) is not int or not 3 <= rep.get("maxRows", 512) <= 2048:
            raise InvocationError("Diagnostic maxRows must be from 3 to 2048")
        if "dbcv" in rep and type(rep["dbcv"]) is not bool:
            raise InvocationError("DBCV option must be boolean")
    for key, allowed in (("modelSignals", {"method", "maxRows", "compareTrain", "units"}), ("challenge", {"method", "maxRows"})):
        if key not in spec:
            continue
        option = spec[key]
        if not isinstance(option, dict) or set(option) - allowed or not public_method(option.get("method")):
            raise InvocationError(f"{key} requires a public method and valid options")
        if type(option.get("maxRows", 512)) is not int or not 2 <= option.get("maxRows", 512) <= 2048:
            raise InvocationError(f"{key}.maxRows must be from 2 to 2048")
        if "compareTrain" in option and type(option["compareTrain"]) is not bool:
            raise InvocationError("modelSignals.compareTrain must be boolean")
        if "units" in option and (not isinstance(option["units"], str) or not 1 <= len(option["units"]) <= 200):
            raise InvocationError("modelSignals.units must be a bounded nonempty string")
    if "volume" in spec:
        volume = spec["volume"]
        if (not isinstance(volume, dict) or set(volume) - {"bounds", "scoreSource", "scoreMethod", "uniformSamples"}
                or volume.get("scoreSource") not in ("pipeline_model", "method") or not public_method(volume.get("scoreMethod"))):
            raise InvocationError("Volume requires explicit scoreSource and scoreMethod")
        import math
        bounds = volume.get("bounds")
        if not isinstance(bounds, list) or not 1 <= len(bounds) <= 6:
            raise InvocationError("Volume diagnostics need bounds for one to six feature dimensions")
        for bound in bounds:
            if (not isinstance(bound, list) or len(bound) != 2 or any(type(x) not in (int, float) or not math.isfinite(x) for x in bound)
                    or bound[0] >= bound[1]):
                raise InvocationError("Volume bounds must be finite increasing pairs")
        if type(volume.get("uniformSamples", 2048)) is not int or not 32 <= volume.get("uniformSamples", 2048) <= 8192:
            raise InvocationError("Volume uniformSamples must be from 32 to 8192")
        if "representation" not in spec:
            raise InvocationError("Volume requires an explicit representation")
    if "contamination" in spec:
        option = spec["contamination"]
        if (not isinstance(option, dict) or set(option) != {"parameter", "values"}
                or not isinstance(option["parameter"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", option["parameter"])
                or option["parameter"].split("__")[-1] == "random_state"):
            raise InvocationError("Contamination requires a non-seed estimator parameter and values")
        values = option["values"]
        if not isinstance(values, list) or not 1 <= len(values) <= 5 or any(type(x) not in (int, float) or not 0 < x < 1 for x in values) or len(set(values)) != len(values):
            raise InvocationError("Contamination values must be one to five unique fractions in (0,1)")
    for key, allowed, bounds in (("slices", {"method", "maxGroups"}, {"maxGroups": (1, 32, 16)}),
                                 ("robustness", {"method", "maxRows", "maxVariants"}, {"maxRows": (2, 2048, 512), "maxVariants": (1, 8, 4)})):
        if key not in spec:
            continue
        option = spec[key]
        if not isinstance(option, dict) or set(option) - allowed or not public_method(option.get("method")):
            raise InvocationError(f"{key} requires a public read-only method and valid options")
        for name, (low, high, default) in bounds.items():
            value = option.get(name, default)
            if type(value) is not int or not low <= value <= high:
                raise InvocationError(f"{key}.{name} must be from {low} to {high}")
    if "learningCurve" in spec:
        option = spec["learningCurve"]
        if not isinstance(option, dict) or set(option) != {"fractions"}:
            raise InvocationError("learningCurve requires fractions")
        values = option["fractions"]
        if (not isinstance(values, list) or not 1 <= len(values) <= 6
                or any(type(x) not in (int, float) or not 0 < x <= 1 for x in values) or len(set(values)) != len(values)):
            raise InvocationError("Learning curves need one to six unique fractions in (0,1]")
    objective = (request.get("search") or {}).get("objective")
    if objective is not None:
        if (not isinstance(objective, dict) or set(objective) != {"kind", "metric", "direction"}
                or objective["kind"] != "proxy" or objective["metric"] not in PROXY_METRICS
                or objective["direction"] not in ("maximize", "minimize")):
            raise InvocationError("Invalid explicit proxy search objective")
        if objective["metric"] in GEOMETRY_METRICS and "representation" not in spec:
            raise InvocationError("Geometry search objective requires diagnostics.representation")
        if objective["metric"] == "dbcv" and not spec["representation"].get("dbcv"):
            raise InvocationError("DBCV search objective requires representation.dbcv=true")
