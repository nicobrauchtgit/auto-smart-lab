"""Shared helpers for SmartLab task solvers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Sequence
import os
import urllib.request
import zipfile


@dataclass(frozen=True)
class ZipTextItem:
    path: str
    text: str
    label: int | None = None


def project_root() -> Path:
    """Return the repo root (parent of agent/)."""
    return Path(__file__).resolve().parents[2]


def download_file(url: str, destination: Path, force: bool = False) -> Path:
    """Download *url* to *destination* unless it already exists."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0 and not force:
        print(f"[download] exists: {destination} ({destination.stat().st_size} bytes)")
        return destination

    tmp = destination.with_suffix(destination.suffix + ".tmp")
    print(f"[download] {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "smartlab-auto-agent/0.1"})
    with urllib.request.urlopen(req, timeout=120) as response, tmp.open("wb") as fh:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            fh.write(chunk)
    os.replace(tmp, destination)
    print(f"[download] wrote: {destination} ({destination.stat().st_size} bytes)")
    return destination


def read_zip_text(zip_path: Path, member: str) -> str:
    with zipfile.ZipFile(zip_path) as zf:
        return zf.read(member).decode("utf-8", errors="replace")


def iter_zip_texts(zip_path: Path, members: Sequence[str]) -> Iterator[tuple[str, str]]:
    """Yield (member_path, decoded_text) for members in one zip open."""
    with zipfile.ZipFile(zip_path) as zf:
        for member in members:
            yield member, zf.read(member).decode("utf-8", errors="replace")


def zip_members(zip_path: Path, prefix: str | None = None) -> list[str]:
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if not n.endswith("/")]
    if prefix is not None:
        names = [n for n in names if n.startswith(prefix)]
    return names


def parse_semicolon_labels(text: str) -> list[tuple[str, int]]:
    rows: list[tuple[str, int]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            path, raw_label = line.rsplit(";", 1)
            label = int(raw_label)
        except Exception as exc:  # pragma: no cover - defensive CLI diagnostics
            raise ValueError(f"Invalid label row {line_no}: {line!r}") from exc
        rows.append((path, label))
    return rows


def write_semicolon_predictions(rows: Iterable[tuple[str, int]], output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as fh:
        for path, label in rows:
            fh.write(f"{path};{int(label)}\n")
    return output_path


def balanced_accuracy(y_true: Sequence[int], y_pred: Sequence[int]) -> float:
    """Balanced accuracy for binary labels 0/1."""
    recalls: list[float] = []
    for klass in (0, 1):
        total = sum(1 for y in y_true if y == klass)
        if total == 0:
            continue
        correct = sum(1 for y, p in zip(y_true, y_pred) if y == klass and p == klass)
        recalls.append(correct / total)
    if not recalls:
        raise ValueError("No labels supplied")
    return sum(recalls) / len(recalls)
