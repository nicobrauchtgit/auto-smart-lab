"""Measurement helpers for the solve stage.

The stage reads the files, not the library that produced them, so nothing here
is load-bearing by itself. The solve prompt nonetheless directs the agent to
`corpus` for reading and `Results` for writing: those are the two steps with a
single correct answer and a failure mode that consumes an entire session.

    from smartlab_eval import Results, load_labelled, balanced_accuracy, roc

`corpus` reads the task archive, `Results` accumulates fold predictions and
writes the results contract, and `metrics` holds the individual measurements if
you would rather assemble your own reporting.
"""
from .corpus import (
    NEUTRAL_SUFFIX,
    corpus_ids,
    load_corpus,
    load_labelled,
    load_labels,
)
from .metrics import (
    FoldScores,
    RocCurve,
    balanced_accuracy,
    calibration,
    compare,
    confusion,
    paired_bootstrap,
    per_class_recall,
    precision_recall,
    roc,
    score_fold,
    threshold_sweep,
)
from .results import SCHEMA_VERSION, Results, read_sealed_ids

__all__ = [
    "FoldScores",
    "NEUTRAL_SUFFIX",
    "Results",
    "RocCurve",
    "SCHEMA_VERSION",
    "balanced_accuracy",
    "calibration",
    "compare",
    "confusion",
    "corpus_ids",
    "load_corpus",
    "load_labelled",
    "load_labels",
    "paired_bootstrap",
    "per_class_recall",
    "precision_recall",
    "roc",
    "score_fold",
    "threshold_sweep",
]
