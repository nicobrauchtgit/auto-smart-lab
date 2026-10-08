"""Materialize and validate concrete cross-validation assignments."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
from sklearn.model_selection import GroupKFold, KFold, StratifiedKFold, train_test_split

from .agent_code import _factory, _load_module
from .invocation import SCHEMA_VERSION, InvocationError, CvSpec, Scope
from .seeds import _derive_seed


@dataclass(frozen=True)
class ConcreteFold:
    repeat: int
    fold: int
    train: tuple[int, ...]
    validation: tuple[int, ...]
    seed: int


def _pilot_indices(y: Sequence[Any], maximum: int, seed: int) -> list[int]:
    if maximum >= len(y):
        return list(range(len(y)))
    if maximum < 2:
        raise InvocationError("pilot maxRows must leave enough rows to represent both classes")
    all_indices = np.arange(len(y))
    labels, counts = np.unique(y, return_counts=True)
    stratify = y if len(labels) > 1 and maximum >= len(labels) and np.all(counts >= 2) else None
    selected, _ = train_test_split(
        all_indices,
        train_size=maximum,
        random_state=seed,
        shuffle=True,
        stratify=stratify,
    )
    return sorted(int(index) for index in selected)


def _as_indices(values: Iterable[Any], name: str, row_count: int) -> tuple[int, ...]:
    try:
        indices = tuple(int(value) for value in values)
    except (TypeError, ValueError) as error:
        raise InvocationError(f"{name} indices must be an iterable of integers") from error
    if not indices:
        raise InvocationError(f"{name} indices must not be empty")
    if len(set(indices)) != len(indices):
        raise InvocationError(f"{name} indices contain duplicates")
    if min(indices) < 0 or max(indices) >= row_count:
        raise InvocationError(f"{name} indices are outside the {row_count}-row corpus")
    return indices


def _normalise_splits(raw: Any, frame: Any, y: Sequence[Any] | None) -> list[tuple[Iterable[Any], Iterable[Any]]]:
    if callable(getattr(raw, "split", None)):
        raw = raw.split(frame, y)
    try:
        return list(raw)
    except TypeError as error:
        raise InvocationError("CV factory must return a splitter or iterable of (train, validation) pairs") from error


def _materialize_folds(
    cv: CvSpec, scope: Scope, frame: Any, y: Sequence[Any] | None, project_root: Path, base_seed: int
) -> list[ConcreteFold]:
    repeats = cv.repeats
    materialized: list[ConcreteFold] = []
    custom_factory = None
    if cv.kind == "factory":
        custom_factory = _factory(_load_module(project_root, cv.module), cv.factory)
    for repeat in range(repeats):
        repeat_seed = _derive_seed("repeat", [base_seed, repeat])
        if cv.kind == "builtin":
            if cv.scheme == "group_kfold":
                if y is None:
                    raise InvocationError("group_kfold requires family/group metadata")
                splitter = GroupKFold(n_splits=cv.folds, shuffle=True, random_state=repeat_seed)
                pairs = list(splitter.split(frame, groups=y))
            else:
                if cv.scheme == "stratified_kfold" and y is None:
                    raise InvocationError("stratified_kfold requires targets; choose kfold or a custom factory")
                splitter = (KFold if cv.scheme == "kfold" else StratifiedKFold)(n_splits=cv.folds, shuffle=True, random_state=repeat_seed)
                pairs = list(splitter.split(frame, y))
        else:
            raw = custom_factory({
                "frame": frame.copy(),
                "y": list(y) if y is not None else None,
                "seed": repeat_seed,
                "repeat": repeat,
                "options": cv.options,
            })
            pairs = _normalise_splits(raw, frame, y)
        if not pairs:
            raise InvocationError(f"CV repeat {repeat} produced no folds")
        for fold_number, pair in enumerate(pairs):
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                raise InvocationError("each CV split must be a (train, validation) pair")
            train = _as_indices(pair[0], "train", len(frame))
            validation = _as_indices(pair[1], "validation", len(frame))
            overlap = set(train).intersection(validation)
            if overlap:
                raise InvocationError(f"repeat {repeat} fold {fold_number} train/validation overlap")
            materialized.append(ConcreteFold(
                repeat=repeat,
                fold=fold_number,
                train=train,
                validation=validation,
                seed=_derive_seed("fold", [repeat_seed, fold_number]),
            ))
    max_folds = scope.max_folds
    if scope.kind == "pilot" and max_folds is not None:
        materialized = materialized[:max_folds]
    _validate_coverage(materialized, len(frame), repeats, scope.kind == "promotion")
    return materialized


def _validate_coverage(folds: Sequence[ConcreteFold], row_count: int, repeats: int, promotion: bool) -> None:
    if not promotion:
        return
    by_repeat: dict[int, list[int]] = {repeat: [] for repeat in range(repeats)}
    for fold in folds:
        by_repeat[fold.repeat].extend(fold.validation)
    expected = list(range(row_count))
    for repeat, observed in by_repeat.items():
        if sorted(observed) != expected:
            raise InvocationError(
                f"promotion repeat {repeat} must validate every row exactly once; "
                f"received {len(observed)} assignments for {row_count} rows"
            )


def _manifest(experiment_id: str, ids: Sequence[str], folds: Sequence[ConcreteFold], scope: Scope, seed: int) -> dict[str, Any]:
    rows = [
        {"id": ids[index], "index": index, "repeat": fold.repeat, "fold": fold.fold}
        for fold in folds
        for index in fold.validation
    ]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": experiment_id,
        "scope": scope.kind,
        "seed": seed,
        "rowCount": len(ids),
        "foldCount": len(folds),
        "assignments": rows,
        "folds": [
            {
                "repeat": fold.repeat,
                "fold": fold.fold,
                "seed": fold.seed,
                "trainIndices": list(fold.train),
                "validationIndices": list(fold.validation),
            }
            for fold in folds
        ],
    }
    digest_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload["sha256"] = hashlib.sha256(digest_payload.encode("utf-8")).hexdigest()
    return payload
