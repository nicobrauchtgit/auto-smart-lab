/**
 * Where the finetuned harness finds things.
 *
 *   REPO_ROOT   the repository: shared task data (units/), node_modules, ./dev
 *   ARM_ROOT    harness/finetuned: this arm's code, configuration and Python project
 *   STATE_ROOT  runs/finetuned: everything a run writes (task runs, solutions/,
 *               deliveries/, submissions/), next to runs/minimal/
 *
 * Functions that take a `projectRoot` (tests pass temporary ones) mean the repository
 * root and reach state through `statePath`.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(ARM_ROOT, "..", "..");
/** Run state below a repository root. */
export const STATE_DIR = ["runs", "finetuned"] as const;
export const statePath = (projectRoot: string, ...parts: string[]) => join(projectRoot, ...STATE_DIR, ...parts);
export const STATE_ROOT = statePath(REPO_ROOT);
/** The repository root a solutions folder belongs to (`<root>/runs/finetuned/solutions`). */
export function repoRootOf(solutionsRoot: string): string {
	const parent = resolve(solutionsRoot, "..");
	return parent.endsWith(join(...STATE_DIR)) ? resolve(parent, "..", "..") : parent;
}
