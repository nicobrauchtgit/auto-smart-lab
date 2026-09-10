#!/usr/bin/env python3
"""Reset all task-specific state so the agent starts from scratch.

The harness is meant to be evaluated the way a student would start: no solver code,
no memory of previous attempts, no prediction files. This script moves that state into
archive/<timestamp>/ (gitignored) instead of deleting it.

Usage:
    python3 agent/setup/reset_state.py            # reset every task
    python3 agent/setup/reset_state.py spam2      # reset a single task
    python3 agent/setup/reset_state.py --dry-run  # show what would move
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TASKS_DIR = REPO_ROOT / "agent" / "smartlab" / "tasks"
MEMORY_FILE = REPO_ROOT / "agent" / "memory" / "memory.json"
SUBMISSIONS_DIR = REPO_ROOT / "submissions"
REPORTS_DIR = REPO_ROOT / "reports"
CHECKPOINTS_DIR = REPO_ROOT / "agent" / "smartlab" / "checkpoints"  # solver-written resume state
ARCHIVE_ROOT = REPO_ROOT / "archive"
EMPTY_MEMORY = {"tasks": {}, "sessions": [], "global_notes": ""}


def _move(src: Path, dest_root: Path, dry_run: bool) -> None:
    rel = src.relative_to(REPO_ROOT)
    print(f"  [archive] {rel}")
    if dry_run:
        return
    dest = dest_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))


def reset(task_id: str | None, dry_run: bool) -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest_root = ARCHIVE_ROOT / stamp
    print(f"[reset] {'DRY RUN — ' if dry_run else ''}archiving to {dest_root.relative_to(REPO_ROOT)}/")

    # 1. Solver modules (and their bytecode)
    if TASKS_DIR.exists():
        for path in sorted(TASKS_DIR.iterdir()):
            if path.name.startswith("_") and path.name != "__pycache__":
                continue
            if path.name == "__pycache__":
                if not dry_run:
                    shutil.rmtree(path)
                continue
            if task_id and path.stem != task_id:
                continue
            _move(path, dest_root, dry_run)

    # 2. Prediction CSVs
    if SUBMISSIONS_DIR.exists():
        for path in sorted(SUBMISSIONS_DIR.iterdir()):
            if task_id and not path.name.startswith(f"{task_id}_"):
                continue
            _move(path, dest_root, dry_run)

    # 3. Agent memory
    if MEMORY_FILE.exists():
        if task_id:
            try:
                mem = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                mem = dict(EMPTY_MEMORY)
            had_task = task_id in mem.get("tasks", {})
            mem.setdefault("tasks", {}).pop(task_id, None)
            mem["sessions"] = [s for s in mem.get("sessions", []) if s.get("task_id") != task_id]
            print(f"  [memory] drop task '{task_id}' ({'present' if had_task else 'absent'}) and its sessions")
            if not dry_run:
                backup = dest_root / "agent" / "memory" / "memory.before.json"
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(MEMORY_FILE, backup)
                MEMORY_FILE.write_text(json.dumps(mem, indent=2) + "\n", encoding="utf-8")
        else:
            _move(MEMORY_FILE, dest_root, dry_run)
            print("  [memory] fresh empty memory.json")
            if not dry_run:
                MEMORY_FILE.write_text(json.dumps(EMPTY_MEMORY, indent=2) + "\n", encoding="utf-8")

    # 4. Solver checkpoints (resume state written by the solver agent)
    if CHECKPOINTS_DIR.exists():
        for path in sorted(CHECKPOINTS_DIR.iterdir()):
            if task_id and path.stem != task_id:
                continue
            _move(path, dest_root, dry_run)

    # 5. Generated reports (full reset only)
    if not task_id and REPORTS_DIR.exists():
        _move(REPORTS_DIR, dest_root, dry_run)

    print("[reset] done." if not dry_run else "[reset] nothing moved (dry run).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("task_id", nargs="?", help="only reset this task (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="print what would be archived")
    args = parser.parse_args()
    return reset(args.task_id, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
