#!/usr/bin/env python3
"""Load a challenge from the persistent store into the agent's environment.

Setup infra: this is part of `agent/setup/` and must never be run by the agent
itself. It swaps exactly one task into `environment/` so the agent's working
context is never overloaded with unrelated tasks.

Train/test separation mirrors the real unit: training data ships with the task,
but the **test data is only injected on explicit request** (week two) so the two
sets are never leaked into each other.

Layout in the store:
  units/<unit>/<task>/prompt.md   -> environment/README.md
  units/<unit>/<task>/data/       -> training inputs (loaded by default)
  units/<unit>/<task>/test/       -> test inputs (loaded only on request)

Zips are extracted at the environment root because SmartLab archives already
carry their own top-level paths (e.g. `data/spam1-train/...`), which must be
preserved so they match the grader's expected submission paths.

Usage:
  # Week one: load prompt + training data (clears the environment first)
  python3 agent/setup/load_challenge.py 01-spam/task1-spam-detection

  # Week two: inject test data into the SAME environment (no clear, no leak)
  python3 agent/setup/load_challenge.py --inject-test 01-spam/task1-spam-detection

  # Reset the environment before the next task
  python3 agent/setup/load_challenge.py --clear
"""
from __future__ import annotations

from pathlib import Path
import argparse
import shutil
import sys
import zipfile

REPO_ROOT = Path(__file__).resolve().parents[2]
STORE_DIR = REPO_ROOT / "units"
ENV_DIR = REPO_ROOT / "environment"


def _resolve_task(task: str) -> Path:
    task_dir = (STORE_DIR / task).resolve()
    if not str(task_dir).startswith(str(STORE_DIR)):
        sys.exit(f"error: task path escapes the store: {task!r}")
    if not task_dir.is_dir():
        sys.exit(f"error: no such task in store: {task_dir}")
    return task_dir


def clear_environment() -> None:
    """Remove every currently loaded file from environment/ (keep the dir)."""
    if not ENV_DIR.exists():
        return
    for entry in sorted(ENV_DIR.iterdir()):
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        print(f"[clear] removed {entry.relative_to(REPO_ROOT)}")


def _place_dir(src: Path, label: str) -> None:
    """Extract zips / copy files from a store dir into the environment root."""
    if not src.is_dir():
        sys.exit(f"error: no '{label}' data at {src}")
    ENV_DIR.mkdir(parents=True, exist_ok=True)
    for entry in sorted(src.iterdir()):
        if entry.suffix == ".zip":
            print(f"[{label}] extracting {entry.name} ...")
            with zipfile.ZipFile(entry) as zf:
                zf.extractall(ENV_DIR)
        elif entry.is_dir():
            shutil.copytree(entry, ENV_DIR / entry.name, dirs_exist_ok=True)
        else:
            shutil.copyfile(entry, ENV_DIR / entry.name)
    print(f"[{label}] -> {ENV_DIR.relative_to(REPO_ROOT)}/")


def load_challenge(task: str) -> None:
    task_dir = _resolve_task(task)
    prompt = task_dir / "prompt.md"
    if not prompt.is_file():
        sys.exit(f"error: no prompt.md found at {prompt}")

    clear_environment()
    ENV_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(prompt, ENV_DIR / "README.md")
    print(f"[load] prompt -> {(ENV_DIR / 'README.md').relative_to(REPO_ROOT)}")

    if (task_dir / "data").is_dir():
        _place_dir(task_dir / "data", "train")
    else:
        print("[load] no training data/ for this task (skipping)")
    print(f"[done] '{task}' loaded (training only) in environment/")


def inject_test(task: str) -> None:
    task_dir = _resolve_task(task)
    if not (ENV_DIR / "README.md").is_file():
        sys.exit("error: no task is loaded in environment/ (run load first)")
    _place_dir(task_dir / "test", "test")
    print(f"[done] test data for '{task}' injected into environment/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "task",
        nargs="?",
        help="Task path relative to units/, e.g. 01-spam/task1-spam-detection",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--inject-test",
        action="store_true",
        help="Inject the task's test data into the current environment (no clear)",
    )
    group.add_argument(
        "--clear",
        action="store_true",
        help="Only clear environment/ (remove the currently loaded task)",
    )
    args = parser.parse_args()

    if args.clear:
        clear_environment()
        print("[done] environment/ cleared")
        return
    if args.inject_test:
        if not args.task:
            parser.error("--inject-test needs a task path")
        inject_test(args.task)
        return
    if not args.task:
        parser.error("provide a task path, or use --inject-test / --clear")
    load_challenge(args.task)


if __name__ == "__main__":
    main()
