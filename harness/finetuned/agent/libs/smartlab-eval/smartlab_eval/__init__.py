"""Read a SmartLab task corpus out of its zip archive.

    from smartlab_eval import load_labelled

`corpus` provides optional text parsing utilities for agent-authored pipelines
and local research. Harness training and refit pass opaque raw sample inputs;
they do not use these decoded-text loaders. Scoring lives in the harness.
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
