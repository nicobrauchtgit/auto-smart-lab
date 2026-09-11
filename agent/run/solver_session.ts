/**
 * Solver session runner.
 * Launches a PI agent session with the solver system prompt,
 * waits for completion, and parses the SOLVER_DONE sentinel.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSession, sessionTimeoutMs } from "./session_runner.js";

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
	const capMin = Math.round(sessionTimeoutMs() / 60000);
	const now = new Date();
	const hardStop = new Date(now.getTime() + sessionTimeoutMs());
	const hhmm = (d: Date) => d.toTimeString().slice(0, 8);
	// Environment facts only (no advice on how to use the time): see agent/instructions/solver.md.
	const clock = ` It is now ${hhmm(now)}; this session is killed at ${hhmm(hardStop)} (${capMin} min cap) and anything unfinished at that point is lost.`;
	const prompt = (feedback
		? `Task: ${taskId}. Feedback on your previous attempt: ${feedback} Your previous solver module is still in place.`
		: `Solve task: ${taskId}.`) + clock;

	console.log(`[solver] Starting session for task ${taskId}${feedback ? " (re-solve)" : ""}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt,
		env: { EVAL_TASK_ID: taskId },
		label: `solver:${taskId}`,
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
