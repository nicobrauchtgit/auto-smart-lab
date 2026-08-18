#!/usr/bin/env npx tsx
/**
 * SmartLab ML Challenge Orchestrator
 *
 * Drives the solver → eval → submit loop for a single task.
 * Only final submissions (smartlab_submit calls) count toward the 3-try limit.
 * Re-solving after a REJECT is free.
 *
 * Usage:
 *   npx tsx agent/run/orchestrate.ts <task_id>
 *
 * Required environment:
 *   LAB_USER, LAB_PASS, LAB_INSECURE_TLS, SMARTLAB_TASK_URL
 *
 * Optional:
 *   TAVILY_API_KEY   — enables web search in the solver
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");

import { ensureSolverScaffold } from "./scaffold.js";
import { runSolverSession } from "./solver_session.js";
import { runEvalSession } from "./eval_session.js";
import { runSubmitSession } from "./submit_session.js";
import { getTaskMemory } from "./memory_utils.js";

const MAX_SUBMISSIONS = 3;

function usage(): never {
	console.error("Usage: npx tsx agent/run/orchestrate.ts <task_id> [--model <id>] [--task-url <url>] [--insecure]");
	console.error("Required env: LAB_USER, LAB_PASS, SMARTLAB_TASK_URL");
	console.error("Examples:");
	console.error("  npm run solve spam1 -- --insecure --task-url https://lab-test.../units/.../tasks/.../");
	console.error("  npm run solve spam1 -- --model gwdg/devstral-2-123b-instruct-2512 --insecure");
	process.exit(1);
}

async function main() {
	const args = process.argv.slice(2);

	function takeArg(flag: string): string | undefined {
		const idx = args.indexOf(flag);
		if (idx === -1) return undefined;
		const val = args[idx + 1];
		args.splice(idx, 2);
		return val;
	}
	function takeFlag(flag: string): boolean {
		const idx = args.indexOf(flag);
		if (idx === -1) return false;
		args.splice(idx, 1);
		return true;
	}

	const model = takeArg("--model");
	const taskUrl = takeArg("--task-url");
	const insecure = takeFlag("--insecure");
	const taskId = args[0];
	if (!taskId) usage();

	if (model) { process.env.PI_MODEL = model; console.log(`[orchestrate] Using model: ${model}`); }
	if (taskUrl) { process.env.SMARTLAB_TASK_URL = taskUrl; }
	if (insecure) { process.env.LAB_INSECURE_TLS = "1"; }

	// Validate required env
	const missing = ["LAB_USER", "LAB_PASS", "SMARTLAB_TASK_URL"].filter((k) => !process.env[k]);
	if (missing.length > 0) {
		console.error(`Missing required environment variables: ${missing.join(", ")}`);
		process.exit(1);
	}

	console.log(`\n[orchestrate] Starting ML challenge loop for task: ${taskId}`);
	console.log(`[orchestrate] Max submissions: ${MAX_SUBMISSIONS}`);

	// Check submission budget from memory
	const initialMem = getTaskMemory(taskId);
	if (initialMem.tries_used >= MAX_SUBMISSIONS) {
		console.error(`[orchestrate] No submissions left for task ${taskId} (${initialMem.tries_used}/${MAX_SUBMISSIONS} used).`);
		process.exit(1);
	}

	// Step 0: Ensure a solver module exists (scaffold if needed)
	await ensureSolverScaffold(taskId);

	let feedback: string | undefined;
	let iteration = 0;

	while (true) {
		iteration++;
		console.log(`\n[orchestrate] === Iteration ${iteration} ===`);

		// Re-check submission budget (updated by submit sessions writing to memory)
		const mem = getTaskMemory(taskId);
		if (mem.tries_used >= MAX_SUBMISSIONS) {
			console.error(`[orchestrate] No submissions left (${mem.tries_used}/${MAX_SUBMISSIONS} used). Stopping.`);
			process.exit(1);
		}
		console.log(`[orchestrate] Submissions: ${mem.tries_used}/${MAX_SUBMISSIONS} used, ${mem.tries_left ?? MAX_SUBMISSIONS - mem.tries_used} remaining`);

		// Step 1: Solver
		const solverResult = await runSolverSession(taskId, feedback);
		console.log(`[orchestrate] Solver done: val_score=${solverResult.valScore}, csv=${solverResult.csvPath}`);

		const csvAbsPath = solverResult.csvPath
			? isAbsolute(solverResult.csvPath) ? solverResult.csvPath : resolve(PROJECT_ROOT, solverResult.csvPath)
			: "";
		if (!csvAbsPath || !existsSync(csvAbsPath)) {
			console.error(`[orchestrate] Solver did not produce a valid CSV at '${csvAbsPath}'. Stopping.`);
			process.exit(2);
		}
		solverResult.csvPath = csvAbsPath;

		// Step 2: Eval
		const evalResult = await runEvalSession(taskId);
		console.log(`[orchestrate] Eval decision: ${evalResult.decision}`);

		if (evalResult.decision === "APPROVE") {
			const csvPath = evalResult.csvPath || solverResult.csvPath;
			console.log(`[orchestrate] Submitting: ${csvPath}`);

			// Step 3: Submit (this consumes a try)
			const submitResult = await runSubmitSession(taskId, csvPath);
			console.log(`[orchestrate] Submission result: ok=${submitResult.ok}, score=${submitResult.score}, tries_left=${submitResult.triesLeft}`);

			if (submitResult.ok) {
				console.log(`\n[orchestrate] SUCCESS — score=${submitResult.score}, tries_left=${submitResult.triesLeft}`);
				process.exit(0);
			} else {
				console.error(`[orchestrate] Submission failed. Check logs.`);
				process.exit(3);
			}
		}

		// REJECT — re-solve is free (only submissions count)
		feedback = evalResult.feedback;
		console.log(`[orchestrate] Re-solving with feedback: "${feedback}"`);
	}
}

main().catch((err) => {
	console.error("[orchestrate] Fatal error:", err);
	process.exit(99);
});
