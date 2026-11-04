/**
 * Solver session runner.
 * Launches a PI agent session with the solver system prompt,
 * waits for completion, and parses the SOLVER_DONE sentinel.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSession, sessionTimeoutMs } from "./session_runner.js";
import { describePythonRuntime } from "./runtime_env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const INSTRUCTIONS = join(AGENT_DIR, "instructions", "solver.md");

export interface SolverResult {
	/** Local score; null when the solver reports none (e.g. a task without training labels). */
	valScore: number | null;
	/** Prediction CSV (file tasks); "" for token tasks. */
	csvPath: string;
	/** Token from the VM's local service (token tasks); undefined for file tasks. */
	token?: string;
	approach: string;
}

/** Facts for the first message: how the task is submitted and what the platform has seen so far. */
export interface SolverTaskFacts {
	submission: "file" | "token";
	/** Unit activation token for the VM's local service, when configured (token tasks). */
	activationToken?: string;
	/** No lab access (since 2026-11): the declared result is final and goes to the instructor. */
	offline?: boolean;
	attemptsUsed: number;
	attemptsMax: number;
	/** Platform results so far, oldest first; `local` is the solver's local score before it, when known. */
	history: { local: number | null; platform: number | null }[];
}

/**
 * Run the solver agent for a given task.
 * @param taskId   Task identifier, e.g. "spam1"
 * @param feedback Optional feedback from a previous eval rejection (for re-solve)
 */
export async function runSolverSession(taskId: string, feedback: string | undefined, task: SolverTaskFacts): Promise<SolverResult> {
	const capMin = Math.round(sessionTimeoutMs() / 60000);
	const now = new Date();
	const hardStop = new Date(now.getTime() + sessionTimeoutMs());
	const hhmm = (d: Date) => d.toTimeString().slice(0, 8);
	// Environment facts only (no advice on how to use the time): see agent/instructions/solver.md.
	const clock = ` It is now ${hhmm(now)}; this session is killed at ${hhmm(hardStop)} (${capMin} min cap) and anything unfinished at that point is lost.`;
	const prompt = (feedback
		? `Task: ${taskId}. Feedback on your previous attempt: ${feedback} Your previous solver module is still in place.`
		: `Solve task: ${taskId}.`) + describePlatform(task) + clock + describePythonRuntime() + describeSubmission(task);

	console.log(`[solver] Starting session for task ${taskId}${feedback ? " (re-solve)" : ""}`);

	const { output } = await runSession({
		instructionsPath: INSTRUCTIONS,
		prompt,
		label: `solver:${taskId}`,
	});

	// Parse SOLVER_DONE sentinel: val_score=<x|none>, then csv=<path> or token=<token>
	const match = output.match(/SOLVER_DONE\s+val_score=(\S+)\s+(csv|token)=(\S+)\s+approach=(.+)/);
	if (!match) {
		// Fallback: try to extract val_score and csv path from output even without the sentinel
		const scoreMatch = output.match(/(?:balanced.accuracy|val.score|validation.score)[^\d]*([\d.]{4,})/i);
		const csvMatch = output.match(/submissions\/\S+\.csv/);
		if (scoreMatch && csvMatch) {
			console.warn(`[solver] WARNING: SOLVER_DONE sentinel missing — reconstructing from output.`);
			return { valScore: parseFloat(scoreMatch[1]), csvPath: csvMatch[0], approach: "(reconstructed)" };
		}
		console.warn(`[solver] WARNING: SOLVER_DONE sentinel not found in output. Last 500 chars:\n${output.slice(-500)}`);
		return { valScore: null, csvPath: "", approach: "" };
	}

	const score = parseFloat(match[1]);
	return {
		valScore: Number.isFinite(score) ? score : null,
		csvPath: match[2] === "csv" ? match[3] : "",
		...(match[2] === "token" ? { token: match[3] } : {}),
		approach: match[4].trim(),
	};
}

function describePlatform(t: SolverTaskFacts): string {
	if (t.offline) {
		return " Delivery: this run has no access to the SmartLab platform. The result your SOLVER_DONE line names is final:" +
			" the orchestrator stores it" + (t.submission === "file" ? " together with a zip of the repository's source files" : "") +
			" and ends the task. It is handed to the course instructor, who scores it after the run; no score comes back during the run.";
	}
	const results = t.history.length
		? ` Platform results so far: ${t.history.map((h, i) => `#${i + 1} ${h.platform ?? "?"}${h.local !== null ? ` (your local score then: ${h.local})` : ""}`).join("; ")}.`
		: "";
	return ` Platform: each submission spends one of the task's ${t.attemptsMax} attempts; ${t.attemptsUsed} of ${t.attemptsMax} used.${results}` +
		" If the platform's grader refuses an upload (e.g. unknown ids), no attempt is counted and its message comes back to you verbatim." +
		" After a submission the platform score comes back to you while attempts remain and the score is below the target." +
		" Output identical to the last submission is not re-submitted; consecutive identical results are capped and the feedback states the count.";
}

function describeSubmission(t: SolverTaskFacts): string {
	if (t.submission === "file") return ""; // the default protocol; unchanged first message for file tasks
	return " This task is submitted as a token returned by the local service (see Protocol); there is no CSV." +
		(t.activationToken ? ` The unit activation token is ${t.activationToken}.` : " No unit activation token is configured for this run.");
}
