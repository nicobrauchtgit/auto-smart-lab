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

/** Thrown when the session ends without an EVAL_DECISION line; the orchestrator retries once. */
export class EvalNoDecisionError extends Error {}

/** Facts the eval agent gets in its first message (it cannot see the platform otherwise). */
export interface EvalFacts {
	/** "file": output.csv + source upload; "token": a token from the VM's local service. */
	submission: "file" | "token";
	/** The candidate: CSV path or token. */
	artifact: string;
	localScore: number | null;
	promptPath: string | null;
	triesUsed: number;
	triesMax: number;
	/** Earlier platform results for this task, oldest first. `local` is null for attempts made before this run. */
	history: { local: number | null; platform: number | null }[];
}

function describeFacts(f: EvalFacts): string {
	const lines = [
		`Candidate: ${f.submission === "token" ? `token=${f.artifact}` : `csv=${f.artifact}`}.`,
		`Solver's local score: ${f.localScore ?? "none reported"}.`,
		`Attempts used on the platform: ${f.triesUsed} of ${f.triesMax}.`,
		f.history.length
			? `Platform results so far: ${f.history.map((h, i) => `#${i + 1} platform ${h.platform ?? "?"} (local ${h.local ?? "unknown"})`).join("; ")}.`
			: "No platform results for this task yet.",
	];
	if (f.promptPath) lines.push(`Task prompt: ${f.promptPath}.`);
	return lines.join(" ");
}

/**
 * Run the eval agent for a given task.
 * @param taskId Task identifier, e.g. "spam1"
 */
export async function runEvalSession(taskId: string, facts: EvalFacts): Promise<EvalResult> {
	const prompt = `Evaluate the solver output for task: ${taskId}. ${describeFacts(facts)} Follow the eval workflow from Step 1.`;

	console.log(`[eval] Starting eval session for task ${taskId}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt,
		env: { EVAL_TASK_ID: taskId },
		label: `eval:${taskId}`,
	});

	// Parse EVAL_DECISION sentinel (csv= is omitted for token tasks)
	const approveMatch = output.match(/EVAL_DECISION:\s*APPROVE(?:\s+csv=(\S+))?/);
	if (approveMatch) {
		return { decision: "APPROVE", csvPath: approveMatch[1] ?? "", feedback: "" };
	}

	const rejectMatch = output.match(/EVAL_DECISION:\s*REJECT\s+feedback="([^"]+)"/);
	if (rejectMatch) {
		return { decision: "REJECT", csvPath: "", feedback: rejectMatch[1] };
	}

	// No decision is not an approval: never submit on a missing sentinel.
	throw new EvalNoDecisionError(`eval ended without a decision sentinel; last 300 chars: ${output.slice(-300).replace(/\s+/g, " ")}`);
}
