"""Load task examples for the harness's own checks.

Only the leakage canary and the champion refit use this. The solve agent reads
the corpus itself; `smartlab_eval.corpus` is the same loader, exposed to it.

Reading goes through that one implementation so the harness and the agent agree
on what an example's id is -- the full path inside the archive -- and so the
zip is opened once rather than once per document.

The frame carries `id` alongside `text` on purpose. A pipeline has no reason to
use the id, and the canary proves it does not by changing the id while holding
the text fixed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

import pandas as pd

from smartlab_eval.corpus import NEUTRAL_SUFFIX, load_corpus

__all__ = ["NEUTRAL_SUFFIX", "load_examples", "neutralize_ids"]


def load_examples(zip_path: Path, ids: Sequence[str]) -> pd.DataFrame:
    """Read the named members out of `zip_path` into an id/text frame."""
    return load_corpus(zip_path, ids)


def neutralize_ids(frame: pd.DataFrame) -> pd.DataFrame:
    """Rewrite training ids to the neutral form the test set uses.

    The text is untouched, so any prediction that changes came from the id.
    """
    neutral = frame.copy()
    neutral["id"] = [f"{row.rsplit('.', 1)[0]}{NEUTRAL_SUFFIX}" for row in frame["id"]]
    return neutral
