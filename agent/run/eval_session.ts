/**
 * Eval session runner.
 * Launches a PI agent session with the eval system prompt,
 * waits for completion, and parses the EVAL_DECISION sentinel.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSession } from "./session_runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const INSTRUCTIONS = join(AGENT_DIR, "instructions", "eval.md");

export type EvalDecision = "APPROVE" | "REJECT";

export interface EvalResult {
	decision: EvalDecision;
	csvPath: string;
	feedback: string;
}

/**
 * Run the eval agent for a given task.
 * @param taskId Task identifier, e.g. "spam1"
 */
export async function runEvalSession(taskId: string): Promise<EvalResult> {
	const prompt = `Evaluate the solver output for task: ${taskId}. Follow the eval workflow from Step 1.`;

	console.log(`[eval] Starting eval session for task ${taskId}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt,
		env: { EVAL_TASK_ID: taskId },
	});

	// Parse EVAL_DECISION sentinel
	const approveMatch = output.match(/EVAL_DECISION:\s*APPROVE\s+csv=(\S+)/);
	if (approveMatch) {
		return { decision: "APPROVE", csvPath: approveMatch[1], feedback: "" };
	}

	const rejectMatch = output.match(/EVAL_DECISION:\s*REJECT\s+feedback="([^"]+)"/);
	if (rejectMatch) {
		return { decision: "REJECT", csvPath: "", feedback: rejectMatch[1] };
	}

	// Fallback: if no sentinel found, log and default to approve to avoid infinite loop
	console.warn(`[eval] WARNING: EVAL_DECISION sentinel not found. Defaulting to APPROVE. Last 500 chars:\n${output.slice(-500)}`);
	return { decision: "APPROVE", csvPath: "", feedback: "" };
}
