/**
 * Generates a minimal solver scaffold for new tasks that have no implementation yet.
 *
 * Called by orchestrate.ts before launching the solver session.
 * If agent/smartlab/tasks/<task_id>.py already exists with real content,
 * this is a no-op (the solver agent will improve the existing code).
 *
 * smartlab_agent.py discovers task modules automatically.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".."); // agent/run/ → agent/
const TASKS_DIR = join(AGENT_DIR, "smartlab", "tasks");

function isScaffoldOrEmpty(content: string): boolean {
	return content.trim().length === 0 || content.includes("raise NotImplementedError");
}

export async function ensureSolverScaffold(taskId: string): Promise<void> {
	const solverPath = join(TASKS_DIR, `${taskId}.py`);

	// If file exists and has real content, leave it alone
	if (existsSync(solverPath)) {
		const content = readFileSync(solverPath, "utf8");
		if (!isScaffoldOrEmpty(content)) {
			return;
		}
	}

	// Write minimal scaffold
	const scaffold = `"""Solver for ${taskId} — auto-generated scaffold. Fill in the implementations below."""
from __future__ import annotations

from pathlib import Path

from smartlab.common import (
    balanced_accuracy,
    download_file,
    iter_zip_texts,
    parse_semicolon_labels,
    write_semicolon_predictions,
    project_root,
)

_ROOT = project_root()
_DATA_DIR = _ROOT / "units"  # data lives in units/<unit>/<task>/data/ (see read_challenge data_dir)
_SUBMISSIONS = _ROOT / "submissions"
_SUBMISSIONS.mkdir(parents=True, exist_ok=True)

DEFAULT_SUBMISSION: Path = _SUBMISSIONS / "${taskId}_predictions.csv"


def download(force: bool = False) -> None:
    """Download training and test data for ${taskId}."""
    raise NotImplementedError("TODO: implement download() for ${taskId}")


def validate(validation_fraction: float = 0.2, seed: int = 13) -> float:
    """Train on a split and return the task's evaluation metric on the holdout set."""
    raise NotImplementedError("TODO: implement validate() for ${taskId}")


def solve(output_path: Path = DEFAULT_SUBMISSION) -> Path:
    """Train on the full training set, write predictions to output_path, return path."""
    raise NotImplementedError("TODO: implement solve() for ${taskId}")
`;

	writeFileSync(solverPath, scaffold, "utf8");
	console.log(`[scaffold] Created stub solver at ${solverPath}`);

	// smartlab_agent.py auto-discovers modules in smartlab/tasks/, no registration needed.
}
