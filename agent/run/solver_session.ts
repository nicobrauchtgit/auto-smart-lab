/**
 * Solver session runner.
 * Launches a PI agent session with the solver system prompt,
 * waits for completion, and parses the SOLVER_DONE sentinel.
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSession } from "./session_runner.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const PROJECT_ROOT = resolve(AGENT_DIR, "..");

export interface SolverResult {
	valScore: number;
	csvPath: string;
	approach: string;
}

/**
 * Run the solver agent for a given task.
 * @param taskId   Task identifier, e.g. "spam1"
 * @param feedback Optional feedback from a previous eval rejection (for re-solve)
 */
export async function runSolverSession(taskId: string, feedback?: string, model?: string): Promise<SolverResult> {
	const researchPath = join(PROJECT_ROOT, "runs", taskId, "research", "research.md");
	const prompts = loadPromptSnapshot();
	const system = prompts.render("solver.system", {});
	const inputs = { taskId, researchState: JSON.stringify({ path: relative(PROJECT_ROOT, researchPath), exists: existsSync(researchPath) }) };
	const start = feedback
		? prompts.render("solver.retry", { ...inputs, feedback })
		: prompts.render("solver.start", inputs);

	console.log(`[solver] Starting session for task ${taskId}${feedback ? " (re-solve)" : ""}`);

	const { output } = await runSession({
		prompts,
		system,
		prompt: start.text,
		promptReferences: [system.reference, start.reference],
		env: { EVAL_TASK_ID: taskId },
		model,
	});

	// Parse SOLVER_DONE sentinel
	const match = output.match(/SOLVER_DONE\s+val_score=([\d.]+)\s+csv=(\S+)\s+approach=(.+)/);
	if (!match) {
		// Fallback: try to extract val_score and csv path from output even without the sentinel
		const scoreMatch = output.match(/(?:balanced.accuracy|val.score|validation.score)[^\d]*([\d.]{4,})/i);
		const csvMatch = output.match(/submissions\/\S+\.csv/);
		if (scoreMatch && csvMatch) {
			console.warn(`[solver] WARNING: SOLVER_DONE sentinel missing — reconstructing from output.`);
			return { valScore: parseFloat(scoreMatch[1]), csvPath: csvMatch[0], approach: "(reconstructed)" };
		}
		console.warn(`[solver] WARNING: SOLVER_DONE sentinel not found in output. Last 500 chars:\n${output.slice(-500)}`);
		return { valScore: 0, csvPath: "", approach: "" };
	}

	return {
		valScore: parseFloat(match[1]),
		csvPath: match[2],
		approach: match[3].trim(),
	};
}
