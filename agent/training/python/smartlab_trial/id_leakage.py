"""Prediction-only identity canary, including raw ZIP member identities."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
import re
import tempfile
from zipfile import ZipFile

import numpy as np

from .metrics import score_observation


def neutral_id(value: str) -> str:
    return re.sub(r"\.[01]$", ".x", value)


@contextmanager
def neutral_validation(frame):
    """Keep sample bytes fixed while removing label suffixes from accessible ZIPs.

    Rename every member in each referenced archive, rather than just changing
    the descriptor: pipelines may inspect namelist() before opening a member.
    Collision-safe aliases also cover archives containing both foo.0 and foo.1.
    """
    neutral = frame.copy(deep=True)
    neutral["id"] = [neutral_id(str(value)) for value in frame["id"]]
    with tempfile.TemporaryDirectory(prefix="identity-canary-") as directory:
        archives = {}
        if "input" in frame:
            inputs = []
            for descriptor in frame["input"]:
                if not isinstance(descriptor, dict) or not {"archive", "member"} <= descriptor.keys():
                    inputs.append(descriptor)
                    continue
                original = str(descriptor["archive"])
                if original not in archives:
                    destination = Path(directory) / f"{len(archives)}.zip"
                    with ZipFile(original) as source, ZipFile(destination, "w") as target:
                        mapping = {}
                        occupied = set()
                        for member in source.infolist():
                            alias = neutral_id(member.filename)
                            if alias in occupied:
                                digest = hashlib.sha256(member.filename.encode()).hexdigest()[:16]
                                alias = f"{digest}/{alias}"
                            occupied.add(alias)
                            mapping[member.filename] = alias
                            # Only names change; preserve identical uncompressed bytes.
                            target.writestr(alias, source.read(member))
                    archives[original] = (str(destination), mapping)
                destination, mapping = archives[original]
                inputs.append({**descriptor, "archive": destination, "member": mapping[str(descriptor["member"])]})
            neutral["input"] = inputs
        yield neutral


def check(estimator, frame, predictions, scores):
    """Silent on match; reject differing labels, scores or neutral-input errors."""
    if not any(neutral_id(str(value)) != str(value) for value in frame["id"]) and not (
        "input" in frame and any(isinstance(value, dict) and neutral_id(str(value.get("member", ""))) != str(value.get("member", ""))
                                 for value in frame["input"])):
        return None
    try:
        with neutral_validation(frame) as neutral:
            neutral_predictions = np.asarray(estimator.predict(neutral))
            neutral_scores, _ = score_observation(estimator, neutral)
        original_predictions = np.asarray(predictions)
        if neutral_predictions.shape != original_predictions.shape:
            return {"rows": len(frame), "mismatches": len(frame)}
        mismatches = neutral_predictions != original_predictions
        if (scores is None) != (neutral_scores is None):
            mismatches[:] = True
        elif scores is not None:
            original_scores, alternate = np.asarray(scores), np.asarray(neutral_scores)
            if original_scores.shape != alternate.shape:
                mismatches[:] = True
            else:
                mismatches |= ~np.isclose(original_scores, alternate, rtol=1e-12, atol=1e-12, equal_nan=False)
        count = int(np.count_nonzero(mismatches))
        return {"rows": len(frame), "mismatches": count} if count else None
    except Exception:
        # A pipeline that only accepts training-label names cannot predict test
        # identities either. Keep authoritative normal predictions for diagnosis.
        return {"rows": len(frame), "mismatches": len(frame), "neutralPredictionFailed": True}
