"""Read the task corpus out of its zip archive.

Loading the corpus is IO plumbing, not modelling, and getting it wrong is
expensive in two specific ways that this module exists to remove.

The first is cost. `zipfile.ZipFile()` parses the whole central directory when
it is constructed, so opening the archive once per document turns a 0.2 s read
of 16,662 files into roughly ten minutes. Every function here opens the archive
once and reads its members inside that one handle.

The second is identity. A member's id is its **full path inside the archive**
(`data/spam1-train/ubqnocmfmxdywlax.0`), which is the exact string the labels
file and the results contract use. Reducing it to a file name produces ids that
match nothing, and the failure surfaces later as an unmeasurable iteration
rather than as a loading mistake. `load_corpus` says so directly when an id
looks like a bare file name.

Nothing here touches features or models. The frame carries `id` alongside
`text` because the harness's leakage canary needs it; the id encodes the
training label in its extension, so a pipeline must never read it.
"""
from __future__ import annotations

import time
import zipfile
from pathlib import Path
from typing import Iterable, Sequence

import pandas as pd

# Training members end in `.0` or `.1`, which encode the label. Test members
# carry a neutral extension instead.
NEUTRAL_SUFFIX = ".x"


def corpus_ids(zip_path: Path | str) -> list[str]:
    """Every member id in `zip_path`, in archive order."""
    with zipfile.ZipFile(Path(zip_path)) as archive:
        return [entry.filename for entry in archive.infolist() if not entry.is_dir()]


def load_corpus(zip_path: Path | str, ids: Sequence[str] | None = None) -> pd.DataFrame:
    """Read `zip_path` into an `id`/`text` frame in one pass.

    With no `ids`, every member is read in archive order. With `ids`, exactly
    those members are read, in the order given, so the frame stays aligned with
    a label vector built from the same sequence.

    The returned frame carries the load's cost in `frame.attrs["corpus_load"]`.
    """
    zip_path = Path(zip_path)
    started = time.perf_counter()
    with zipfile.ZipFile(zip_path) as archive:
        if ids is None:
            members = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        else:
            members = [str(row_id) for row_id in ids]
            available = {entry.filename for entry in archive.infolist()}
            missing = [member for member in members if member not in available]
            if missing:
                raise KeyError(_missing_message(zip_path, missing, available))
        texts = [archive.read(member).decode("utf-8", errors="replace") for member in members]

    frame = pd.DataFrame({"id": members, "text": texts})
    elapsed = time.perf_counter() - started
    frame.attrs["corpus_load"] = {
        "zip": zip_path.name,
        "rows": len(members),
        "seconds": elapsed,
        "characters": sum(len(text) for text in texts),
        "ms_per_document": 1000 * elapsed / len(members) if members else 0.0,
    }
    return frame


def load_labels(labels_path: Path | str) -> dict[str, int]:
    """Read a `path;label` file into `{id: label}`, preserving file order."""
    labels_path = Path(labels_path)
    table: dict[str, int] = {}
    for number, line in enumerate(labels_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        row_id, separator, raw = line.rpartition(";")
        if not separator or not row_id or raw not in {"0", "1"}:
            raise ValueError(f"{labels_path.name} line {number} is not a path;binary-label record: {line!r}")
        table[row_id] = int(raw)
    return table


def load_labelled(
    zip_path: Path | str,
    labels_path: Path | str,
    ids: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, list[int]]:
    """Read the labelled rows as an aligned `(frame, y)` pair.

    The frame holds `id` and `text` only. The labels come back beside it rather
    than as a column so that the frame can be handed straight to a pipeline
    without the target travelling with it.
    """
    labels = load_labels(labels_path)
    wanted = list(labels) if ids is None else [str(row_id) for row_id in ids]
    unlabelled = [row_id for row_id in wanted if row_id not in labels]
    if unlabelled:
        raise KeyError(
            f"{len(unlabelled)} requested id(s) have no label in {Path(labels_path).name}, "
            f"first {unlabelled[0]!r}",
        )
    frame = load_corpus(zip_path, wanted)
    return frame, [labels[row_id] for row_id in wanted]


def id_form_hint(unknown: Sequence[str], known: Iterable[str]) -> str:
    """Name the id-form mistake behind a set of unrecognised ids, if that is what it is.

    Writing the file name where the full archive path belongs invalidates every
    row at once while saying nothing about the model. Reported as a bare count
    it reads as a coverage problem, so every place that rejects ids -- the
    loader, the results writer, and the stage's own compliance check -- explains
    it the same way from here.

    Returns a fragment to append to a message, or an empty string when the ids
    are simply absent.
    """
    by_name: dict[str, str] = {}
    for row_id in known:
        by_name.setdefault(row_id.rsplit("/", 1)[-1], row_id)
    matched = [row_id for row_id in unknown if by_name.get(row_id.rsplit("/", 1)[-1], row_id) != row_id]
    if not matched:
        return ""
    example = matched[0]
    return (
        f"; {len(matched)} of them match a known row by file name, such as {example!r} for "
        f"{by_name[example.rsplit('/', 1)[-1]]!r}. An id is the full path inside the archive, "
        "which is the form the labels file, the sealed id list, and the results files all use"
    )


def _missing_message(zip_path: Path, missing: Sequence[str], available: set[str]) -> str:
    return f"{len(missing)} id(s) are not in {zip_path.name}, first {missing[0]!r}{id_form_hint(missing, available)}"
