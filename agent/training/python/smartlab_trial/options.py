"""Validate opt-in measurement requests at the worker boundary."""
import re
from typing import Any
from .invocation import InvocationError

PROXY_METRICS = {"silhouette", "calinskiHarabasz", "daviesBouldin", "dbcv", "estimator_score"}


def validate_options(request: dict[str, Any]) -> None:
    spec = request.get("diagnostics", {})
    if not isinstance(spec, dict) or set(spec) - {"representation", "predictionStrength"}:
        raise InvocationError("Invalid diagnostics options")
    if "predictionStrength" in spec and type(spec["predictionStrength"]) is not bool:
        raise InvocationError("diagnostics.predictionStrength must be boolean")
    if "representation" in spec:
        rep = spec["representation"]
        if not isinstance(rep, dict) or set(rep) - {"source", "method", "metric", "maxRows", "dbcv"}:
            raise InvocationError("Invalid representation options")
        if rep.get("source") not in ("pipeline_features", "method"):
            raise InvocationError("Representation requires pipeline_features or method")
        if rep["source"] == "method" and (not isinstance(rep.get("method"), str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", rep["method"])):
            raise InvocationError("Representation requires a public method name")
        if rep["source"] == "pipeline_features" and "method" in rep:
            raise InvocationError("pipeline_features does not accept method")
        if rep.get("metric", "euclidean") not in ("euclidean", "cosine"):
            raise InvocationError("Unsupported diagnostic distance")
        if type(rep.get("maxRows", 512)) is not int or not 3 <= rep.get("maxRows", 512) <= 2048:
            raise InvocationError("Diagnostic maxRows must be from 3 to 2048")
        if "dbcv" in rep and type(rep["dbcv"]) is not bool:
            raise InvocationError("DBCV option must be boolean")
    objective = (request.get("search") or {}).get("objective")
    if objective is not None:
        if (not isinstance(objective, dict) or set(objective) != {"kind", "metric", "direction"}
                or objective["kind"] != "proxy" or objective["metric"] not in PROXY_METRICS
                or objective["direction"] not in ("maximize", "minimize")):
            raise InvocationError("Invalid explicit proxy search objective")
        if objective["metric"] != "estimator_score" and "representation" not in spec:
            raise InvocationError("Geometry search objective requires diagnostics.representation")
        if objective["metric"] == "dbcv" and not spec["representation"].get("dbcv"):
            raise InvocationError("DBCV search objective requires representation.dbcv=true")
