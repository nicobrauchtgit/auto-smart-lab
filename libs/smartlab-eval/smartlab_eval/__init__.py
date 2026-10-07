"""Read a SmartLab task corpus out of its zip archive.

    from smartlab_eval import load_labelled

`corpus` reads the task archive in one pass and keeps member ids aligned with
the labels file. The harness workers use it; scoring lives in the harness.
"""
from .corpus import (
    NEUTRAL_SUFFIX,
    corpus_ids,
    load_corpus,
    load_labelled,
    load_labels,
)

__all__ = [
    "NEUTRAL_SUFFIX",
    "corpus_ids",
    "load_corpus",
    "load_labelled",
    "load_labels",
]
