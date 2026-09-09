"""Re-run the champion pipeline under the current iteration's folds.

A paired comparison only means anything when both models saw the same splits,
and the fold seed rotates every iteration precisely so a gain cannot be ground
out of one fixed partition. Reconciling those two facts means the champion has
to be re-fitted under the challenger's folds, which is what this does.

This is the only place the harness executes the agent's code for its own
purposes. It costs one extra cross-validation pass per iteration.
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

import numpy as np

from .corpus import load_examples
from .entrypoint import load_factory


def stratified_folds(labels: Sequence[int], folds: int, seed: int) -> np.ndarray:
    """Fold index per row, stratified, matching the recommendation's shape."""
    assignment = np.empty(len(labels), dtype=int)
    rng = np.random.default_rng(seed)
    for label in (0, 1):
        rows = np.flatnonzero(np.asarray(labels) == label)
        rng.shuffle(rows)
        assignment[rows] = np.arange(rows.size) % folds
    return assignment


def champion_out_of_fold(
    project_root: Path,
    zip_path: Path,
    module_path: str,
    factory_name: str,
    ids: Sequence[str],
    labels: Sequence[int],
    folds: int,
    seed: int,
) -> dict:
    """Out-of-fold predictions for the champion on the challenger's folds."""
    factory = load_factory(project_root, module_path, factory_name)
    frame = load_examples(zip_path, list(ids))
    y = np.asarray(labels)
    assignment = stratified_folds(labels, folds, seed)
    predictions = np.empty(len(ids), dtype=int)
    for fold in range(folds):
        holdout = assignment == fold
        model = factory().fit(frame[~holdout], y[~holdout])
        predictions[holdout] = np.asarray(model.predict(frame[holdout]), dtype=int)
    return {
        "ids": list(ids),
        "labels": y.tolist(),
        "predictions": predictions.tolist(),
        "folds": assignment.tolist(),
    }


def main(argv: list[str] | None = None) -> int:
    """Run as a separate process.

    The champion is a snapshot of earlier code that usually shares module names
    with the current tree. Loading both in one interpreter would hand the second
    import Python's cached copy of the first, so the comparison would silently
    run the challenger against itself. A separate process is the reliable fix.
    """
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Out-of-fold predictions for a champion snapshot")
    parser.add_argument("--root", required=True, help="snapshot root the champion is imported from")
    parser.add_argument("--zip", required=True)
    parser.add_argument("--module", required=True)
    parser.add_argument("--factory", default="build_pipeline")
    parser.add_argument("--ids", required=True, help="newline-delimited id file")
    parser.add_argument("--labels", required=True, help="full labels file")
    parser.add_argument("--folds", type=int, required=True)
    parser.add_argument("--seed", type=int, required=True)
    arguments = parser.parse_args(argv)

    ids = [line.strip() for line in Path(arguments.ids).read_text(encoding="utf-8").splitlines() if line.strip()]
    table = {}
    for line in Path(arguments.labels).read_text(encoding="utf-8").splitlines():
        if line.strip():
            row_id, _, raw = line.strip().rpartition(";")
            table[row_id] = int(raw)
    result = champion_out_of_fold(
        project_root=Path(arguments.root),
        zip_path=Path(arguments.zip),
        module_path=arguments.module,
        factory_name=arguments.factory,
        ids=ids,
        labels=[table[row_id] for row_id in ids],
        folds=arguments.folds,
        seed=arguments.seed,
    )
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
