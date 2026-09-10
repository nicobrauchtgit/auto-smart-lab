#!/usr/bin/env python3
"""Command-line entry point for the SmartLab auto-agent pipeline."""
from __future__ import annotations

import argparse
import importlib
import pkgutil
from pathlib import Path
import sys
from types import ModuleType

import smartlab.tasks as _tasks_pkg


def _discover_tasks() -> dict[str, ModuleType]:
    """Import every module in smartlab/tasks/ (except private ones) as a task solver.

    Task modules are created by the solver agent (or scaffolded by the orchestrator);
    nothing needs to be registered by hand.
    """
    found: dict[str, ModuleType] = {}
    for info in pkgutil.iter_modules(_tasks_pkg.__path__):
        if info.name.startswith("_"):
            continue
        found[info.name] = importlib.import_module(f"smartlab.tasks.{info.name}")
    return found


TASKS = _discover_tasks()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="SmartLab adversarial-AI exercise pipeline",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="List implemented task solvers")

    download_parser = subparsers.add_parser("download", help="Download data for a task")
    download_parser.add_argument("task", choices=TASKS)
    download_parser.add_argument("--force", action="store_true", help="Re-download existing files")

    validate_parser = subparsers.add_parser("validate", help="Run local validation for a task")
    validate_parser.add_argument("task", choices=TASKS)
    validate_parser.add_argument("--validation-fraction", type=float, default=0.2)
    validate_parser.add_argument("--seed", type=int, default=13)
    validate_parser.add_argument("--download", action="store_true", help="Download data before validating")

    solve_parser = subparsers.add_parser("solve", help="Train on all labels and write predictions")
    solve_parser.add_argument("task", choices=TASKS)
    solve_parser.add_argument("--download", action="store_true", help="Download data before solving")
    solve_parser.add_argument("--out", type=Path, default=None, help="Prediction CSV path")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "list":
        print("Implemented tasks:")
        for name in sorted(TASKS):
            print(f"  - {name}")
        return 0

    task_module = TASKS[args.task]

    if args.command == "download":
        task_module.download(force=args.force)
        return 0

    if args.command == "validate":
        if args.download:
            task_module.download()
        if not 0 < args.validation_fraction < 1:
            raise SystemExit("--validation-fraction must be between 0 and 1")
        score = task_module.validate(validation_fraction=args.validation_fraction, seed=args.seed)
        print(f"VALIDATE_SCORE={float(score):.6f}")
        return 0

    if args.command == "solve":
        if args.download:
            task_module.download()
        output_path = args.out if args.out is not None else task_module.DEFAULT_SUBMISSION
        result_path = task_module.solve(output_path=output_path)
        print(f"SOLVE_CSV={result_path if result_path is not None else output_path}")
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    sys.exit(main())
