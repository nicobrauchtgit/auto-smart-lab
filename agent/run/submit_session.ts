/**
 * Submit session runner.
 * Launches a minimal PI agent session that calls smartlab_submit
 * and writes the result back to memory.
 */

import { dirname, fileURLToPath, join, resolve } from "node:path";
import { runSession } from "./session_runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const INSTRUCTIONS = join(AGENT_DIR, "instructions", "submit_once.md");

export interface SubmitResult {
	ok: boolean;
	score: number | null;
	triesLeft: number | null;
}

/**
 * Run a minimal submission session for a given task and CSV path.
 * @param taskId  Task identifier, e.g. "spam1"
 * @param csvPath Path to the prediction CSV to submit
 */
export async function runSubmitSession(taskId: string, csvPath: string): Promise<SubmitResult> {
	console.log(`[submit] Submitting ${csvPath} for task ${taskId}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt: `Submit the prediction CSV for task ${taskId}. CSV path: ${csvPath}`,
		env: {
			EVAL_TASK_ID: taskId,
			CSV_PATH: csvPath,
		},
	});

	// Parse SUBMIT_DONE sentinel: SUBMIT_DONE score=<X> tries_left=<Y>
	const match = output.match(/SUBMIT_DONE\s+score=([\d.]+|null)\s+tries_left=(\d+)/);
	if (match) {
		const scoreStr = match[1];
		return {
			ok: true,
			score: scoreStr === "null" ? null : parseFloat(scoreStr),
			triesLeft: parseInt(match[2], 10),
		};
	}

	console.warn(`[submit] WARNING: SUBMIT_DONE sentinel not found. Output tail:\n${output.slice(-300)}`);
	return { ok: false, score: null, triesLeft: null };
}
