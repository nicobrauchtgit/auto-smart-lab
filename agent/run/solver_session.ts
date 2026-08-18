/**
 * Solver session runner.
 * Launches a PI agent session with the solver system prompt,
 * waits for completion, and parses the SOLVER_DONE sentinel.
 */

import { dirname, fileURLToPath, join, resolve } from "node:path";
import { runSession } from "./session_runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const INSTRUCTIONS = join(AGENT_DIR, "instructions", "solver.md");

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
export async function runSolverSession(taskId: string, feedback?: string): Promise<SolverResult> {
	const prompt = feedback
		? `Task: ${taskId}. Previous eval feedback: ${feedback}. Build on your previous solver implementation — do not start from scratch unless the current approach is fundamentally broken. Resume from Step 4 of the solver workflow.`
		: `Solve task: ${taskId}. Follow the complete solver workflow from Step 1.`;

	console.log(`[solver] Starting session for task ${taskId}${feedback ? " (re-solve)" : ""}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt,
		env: { EVAL_TASK_ID: taskId },
	});

	// Parse SOLVER_DONE sentinel
	const match = output.match(/SOLVER_DONE\s+val_score=([\d.]+)\s+csv=(\S+)\s+approach=(.+)/);
	if (!match) {
		console.warn(`[solver] WARNING: SOLVER_DONE sentinel not found in output. Last 500 chars:\n${output.slice(-500)}`);
		return { valScore: 0, csvPath: "", approach: "" };
	}

	return {
		valScore: parseFloat(match[1]),
		csvPath: match[2],
		approach: match[3].trim(),
	};
}
