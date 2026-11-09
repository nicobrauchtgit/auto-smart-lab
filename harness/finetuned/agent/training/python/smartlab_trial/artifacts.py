"""Durable trial artifacts and progress events."""
from __future__ import annotations

import csv
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence, TextIO

import numpy as np

from .invocation import SCHEMA_VERSION


class EventWriter:
    def __init__(self, output_dir: Path, experiment_id: str) -> None:
        self.path = output_dir / "events.jsonl"
        self.experiment_id = experiment_id
        self.identity = {
            key: os.environ[variable]
            for key, variable in (("pipelineRunId", "PIPELINE_RUN_ID"),
                                  ("stageInvocationId", "PIPELINE_STAGE_INVOCATION_ID"))
            if os.environ.get(variable)
        }

    def emit(self, kind: str, **data: Any) -> None:
        event = {
            "schemaVersion": SCHEMA_VERSION,
            "experimentId": self.experiment_id,
            "type": kind,
            "timestamp": time.time(),
            **self.identity,
            **_jsonable(data),
        }
        line = json.dumps(event, sort_keys=True, separators=(",", ":"), allow_nan=False)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
            stream.flush()
        print(line, flush=True)


    @contextmanager
    def stage(self, name: str, **coordinates: Any) -> Iterator[None]:
        """Record nested worker actions without changing pipeline stage ownership."""
        self.emit("action_started", stage=name, **coordinates)
        started = time.monotonic()
        try:
            yield
        except BaseException as error:
            self.emit("action_failed", stage=name, **coordinates,
                      durationSeconds=time.monotonic() - started,
                      error={"type": type(error).__name__, "message": str(error)})
            raise
        else:
            self.emit("action_completed", stage=name, **coordinates,
                      durationSeconds=time.monotonic() - started)


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    return value


def _atomic_write(path: Path, write_fn: Callable[[TextIO], None], *, newline: str | None = None) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline=newline) as stream:
            write_fn(stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def _atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    def write(stream: TextIO) -> None:
        json.dump(_jsonable(document), stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")

    _atomic_write(path, write)


def _write_oof(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    def write(stream: TextIO) -> None:
        writer = csv.DictWriter(
            stream,
            fieldnames=["id", "repeat", "fold", "prediction", "score"],
            delimiter=";",
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)

    _atomic_write(path, write, newline="")


def append_fold_result(path: Path, result: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_summary(output_dir: Path, summary: dict[str, Any]) -> None:
    # Both names are part of the existing artifact contract.
    for name in ("metrics.json", "trial-result.json"):
        _atomic_json(output_dir / name, summary)
