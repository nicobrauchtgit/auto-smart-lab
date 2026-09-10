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

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");

/** Quick smoke-test: send a minimal chat completion and verify a response comes back. */
async function checkModel(modelId: string): Promise<void> {
	// Read base URL + api key from ~/.pi/agent/models.json
	const modelsPath = join(process.env.HOME ?? "~", ".pi", "agent", "models.json");
	if (!existsSync(modelsPath)) return; // can't check without config — skip

	const config = JSON.parse(readFileSync(modelsPath, "utf8")) as {
		providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
	};

	// modelId is like "gwdg/deepseek-v4-flash-0731" — split on first "/"
	const slash = modelId.indexOf("/");
	const providerName = slash > 0 ? modelId.slice(0, slash) : modelId;
	const modelName = slash > 0 ? modelId.slice(slash + 1) : modelId;
	const provider = config.providers?.[providerName];
	if (!provider?.baseUrl) return; // unknown provider — skip

	const baseUrl = provider.baseUrl.replace(/\/$/, "");
	const apiKey = provider.apiKey ?? "";
	const url = new URL(`${baseUrl}/chat/completions`);
	const isHttps = url.protocol === "https:";
	const body = Buffer.from(JSON.stringify({
		model: modelName,
		messages: [{ role: "user", content: "Hi" }],
		max_tokens: 5,
	}));

	process.stdout.write(`[orchestrate] Checking model ${modelId} ... `);
	const start = Date.now();

	await new Promise<void>((res, rej) => {
		const req = (isHttps ? httpsRequest : httpRequest)(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
					"Content-Length": body.length,
				},
				// Accept self-signed certs (lab environment)
				rejectUnauthorized: false,
			},
			(r) => {
				const chunks: Buffer[] = [];
				r.on("data", (c) => chunks.push(c as Buffer));
				r.on("end", () => {
					const text = Buffer.concat(chunks).toString();
					// A 404 here means "Model Not Found" — the model ID is not served
					// by the API even if it appears in models.json. Treat as fatal.
					if (r.statusCode === 404 || /model not found/i.test(text)) {
						rej(new Error(`model "${modelName}" not served by ${providerName} API (HTTP 404 Model Not Found)`));
					} else if (r.statusCode && r.statusCode < 500) {
						// 2xx works; other 4xx (e.g. 400 param quibble) = endpoint reachable, model valid
						const label = r.statusCode === 200 ? "ok" : `reachable (HTTP ${r.statusCode})`;
						console.log(`${label} (${Date.now() - start}ms)`);
						res();
					} else {
						rej(new Error(`HTTP ${r.statusCode}: ${text.slice(0, 200)}`));
					}
				});
			}
		);
		req.on("error", rej);
		req.setTimeout(15_000, () => req.destroy(new Error("timeout after 15s")));
		req.write(body);
		req.end();
	});
}

/** Find task URL from units/index.json or units/<unit>/<task>/meta.json */
function findTaskUrl(taskId: string): string | undefined {
	// 1. Check units/index.json (short IDs like "spam1", "spam2")
	const indexPath = join(UNITS_DIR, "index.json");
	if (existsSync(indexPath)) {
		try {
			const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>;
			if (index[taskId]) return index[taskId];
		} catch { /* skip */ }
	}

	// 2. Fall back: scan meta.json files for slug/title substring match
	if (!existsSync(UNITS_DIR)) return undefined;
	const id = taskId.toLowerCase();
	for (const unit of readdirSync(UNITS_DIR)) {
		const unitDir = join(UNITS_DIR, unit);
		if (!statSync(unitDir).isDirectory()) continue;
		for (const task of readdirSync(unitDir)) {
			const metaPath = join(unitDir, task, "meta.json");
			if (!existsSync(metaPath)) continue;
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { task_slug?: string; url?: string; task?: string; short_id?: string };
				const slug = (meta.task_slug ?? "").toLowerCase();
				const title = (meta.task ?? "").toLowerCase();
				const shortId = (meta.short_id ?? "").toLowerCase();
				if (shortId === id || slug === id || task === id || slug.includes(id) || title.includes(id)) return meta.url;
			} catch { /* skip */ }
		}
	}
	return undefined;
}

import { ensureSolverScaffold } from "./scaffold.js";
import { runSolverSession } from "./solver_session.js";
import { runEvalSession } from "./eval_session.js";
import { runSubmitSession } from "./submit_session.js";
import { getTaskMemory, updateTaskMemory } from "./memory_utils.js";
import type { SolverResult } from "./solver_session.js";

const MAX_SUBMISSIONS = 3;
/** Platform score at or above which we stop iterating. Override with --target. */
const DEFAULT_TARGET = 0.97;
/** How many solver sessions may time out / fail to produce a CSV before we give up on the task. */
const MAX_SOLVER_FAILURES = 2;
const AGENT_DIR = join(PROJECT_ROOT, "agent");

/** Run `smartlab_agent.py <cmd> <task>` and return stdout+stderr (or null on failure/timeout). */
function runCli(cmd: string, taskId: string, timeoutMs: number): string | null {
	const r = spawnSync("python3", ["smartlab_agent.py", cmd, taskId], { cwd: AGENT_DIR, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	if (r.error || r.status !== 0) {
		console.warn(`[salvage] ${cmd} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
		return null;
	}
	return out;
}

/**
 * The solver session died (timeout) or ended without a usable CSV, but it may have left a working
 * solver module behind. Run validate + solve deterministically (no LLM) and, if that works, carry on
 * to eval/submit as if the solver had finished. Returns null when there is nothing to salvage.
 */
function salvageSolver(taskId: string): SolverResult | null {
	const solverPath = join(AGENT_DIR, "smartlab", "tasks", `${taskId}.py`);
	if (!existsSync(solverPath) || readFileSync(solverPath, "utf8").includes("raise NotImplementedError")) {
		console.warn(`[salvage] no implemented solver at ${solverPath}`);
		return null;
	}
	console.log(`[salvage] solver module exists — running validate + solve directly (no LLM)`);
	const v = runCli("validate", taskId, 15 * 60 * 1000);
	const vm = v?.match(/VALIDATE_SCORE=([\d.]+)/);
	if (!vm) return null;
	const valScore = parseFloat(vm[1]);
	const so = runCli("solve", taskId, 20 * 60 * 1000);
	const sm = so?.match(/SOLVE_CSV=(\S+)/);
	if (!sm) return null;
	const csvPath = sm[1];
	if (!existsSync(csvPath)) { console.warn(`[salvage] solve reported ${csvPath} but it does not exist`); return null; }
	const approach = "(salvaged: solver session ended early; predictions produced by running its module directly)";
	updateTaskMemory(taskId, { last_val_score: valScore, last_submission_csv: csvPath, approach });
	console.log(`[salvage] ok: val_score=${valScore}, csv=${csvPath}`);
	return { valScore, csvPath, approach };
}

function usage(): never {
	console.error("Usage: npx tsx agent/run/orchestrate.ts <task_id|list> [--model <id>] [--task-url <url>] [--insecure] [--no-submit] [--target <score>] [--solver-timeout <minutes>]");
	console.error("Required env: LAB_USER, LAB_PASS");
	console.error("Examples:");
	console.error("  npm run solve list                    # show all available task IDs");
	console.error("  npm run solve spam3 -- --insecure     # solve task spam3");
	console.error("  npm run solve spam3 -- --insecure --model gwdg/devstral-2-123b-instruct-2512");
	console.error("  npm run solve spam1 -- --insecure --no-submit   # run solver+eval, skip the real submission");
	console.error("  npm run solve spam2 -- --insecure --target 0.95 # keep re-solving + submitting until the platform score >= 0.95");
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
	const noSubmit = takeFlag("--no-submit");
	const solverTimeoutArg = takeArg("--solver-timeout");
	if (solverTimeoutArg !== undefined) {
		const mins = Number(solverTimeoutArg);
		if (!Number.isFinite(mins) || mins <= 0) usage();
		process.env.PI_SESSION_TIMEOUT_MS = String(Math.round(mins * 60 * 1000));
	}
	const targetArg = takeArg("--target");
	const target = targetArg !== undefined ? Number(targetArg) : DEFAULT_TARGET;
	if (!Number.isFinite(target)) usage();
	const taskId = args[0];
	if (!taskId) usage();

	// List available tasks
	if (taskId === "list") {
		const indexPath = join(UNITS_DIR, "index.json");
		if (!existsSync(indexPath)) {
			console.error("No units/index.json found. Run: python3 agent/setup/fetch_units.py --insecure");
			process.exit(1);
		}
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>;
		// Collect titles from meta.json
		const meta: Record<string, { unit: string; task: string }> = {};
		if (existsSync(UNITS_DIR)) {
			for (const unit of readdirSync(UNITS_DIR)) {
				const unitDir = join(UNITS_DIR, unit);
				if (!statSync(unitDir).isDirectory()) continue;
				for (const task of readdirSync(unitDir)) {
					const mp = join(unitDir, task, "meta.json");
					if (!existsSync(mp)) continue;
					try {
						const m = JSON.parse(readFileSync(mp, "utf8")) as { short_id?: string; unit?: string; task?: string };
						if (m.short_id) meta[m.short_id] = { unit: m.unit ?? "", task: m.task ?? "" };
					} catch { /* skip */ }
				}
			}
		}
		console.log("Available tasks:\n");
		console.log("  ID              Unit                           Task");
		console.log("  " + "-".repeat(80));
		for (const [id] of Object.entries(index)) {
			const m = meta[id];
			const unit = (m?.unit ?? "").slice(0, 30).padEnd(30);
			const task = (m?.task ?? "").slice(0, 50);
			console.log(`  ${id.padEnd(16)} ${unit}  ${task}`);
		}
		process.exit(0);
	}

	if (model) {
		process.env.PI_MODEL = model;
		console.log(`[orchestrate] Using model: ${model}`);
		try {
			await checkModel(model);
		} catch (err) {
			// Health check failed — warn but continue; the PI SDK uses its own auth flow
			console.warn(`[orchestrate] Model pre-check warning: ${err}`);
			console.warn(`  Continuing anyway — the SDK may still be able to use this model.`);
		}
	}
	if (taskUrl) { process.env.SMARTLAB_TASK_URL = taskUrl; }
	if (insecure) { process.env.LAB_INSECURE_TLS = "1"; }

	// Auto-resolve task URL from units/<unit>/<task>/meta.json if not set
	if (!process.env.SMARTLAB_TASK_URL) {
		const found = findTaskUrl(taskId);
		if (found) {
			process.env.SMARTLAB_TASK_URL = found;
			console.log(`[orchestrate] Resolved task URL from meta.json: ${found}`);
		} else {
			console.error(`[orchestrate] Could not resolve task URL for '${taskId}'.`);
			console.error(`  Either set SMARTLAB_TASK_URL in the environment, pass --task-url <url>,`);
			console.error(`  or run: python3 agent/setup/fetch_units.py --insecure`);
			process.exit(1);
		}
	}

	// Validate required env
	const missing = ["LAB_USER", "LAB_PASS"].filter((k) => !process.env[k]);
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
	let solverFailures = 0;
	let lastSubmittedHash: string | undefined;
	let lastPlatformScore: number | null = null;
	console.log(`[orchestrate] Target platform score: ${target}`);

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
		let solverResult: SolverResult;
		let solverProblem: string | undefined;
		try {
			solverResult = await runSolverSession(taskId, feedback);
			console.log(`[orchestrate] Solver done: val_score=${solverResult.valScore}, csv=${solverResult.csvPath}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!/timed out/i.test(msg)) throw err;
			console.warn(`[orchestrate] Solver session timed out: ${msg}`);
			solverProblem = "timed out";
			solverResult = { valScore: 0, csvPath: "", approach: "" };
		}

		let csvAbsPath = solverResult.csvPath
			? isAbsolute(solverResult.csvPath) ? solverResult.csvPath : resolve(PROJECT_ROOT, solverResult.csvPath)
			: "";
		if (!csvAbsPath || !existsSync(csvAbsPath)) {
			solverProblem ??= "ended without a prediction CSV";
			const salvaged = salvageSolver(taskId);
			if (salvaged) {
				solverResult = salvaged;
				csvAbsPath = isAbsolute(salvaged.csvPath) ? salvaged.csvPath : resolve(PROJECT_ROOT, salvaged.csvPath);
			} else {
				solverFailures++;
				if (solverFailures >= MAX_SOLVER_FAILURES) {
					console.error(`[orchestrate] Solver ${solverProblem} ${solverFailures} time(s) and nothing could be salvaged. Stopping.`);
					process.exit(2);
				}
				feedback = `Your previous session ${solverProblem} before producing predictions. You have one more session. ` +
					`Do not explore or tune: get a simple working model, run validate once, run solve, verify the CSV, write memory and print SOLVER_DONE — all within the first half of the session.`;
				console.log(`[orchestrate] Nothing to salvage — re-running solver with finish-first instructions.`);
				continue;
			}
		}
		solverResult.csvPath = csvAbsPath;

		// Step 2: Eval
		const evalResult = await runEvalSession(taskId);
		console.log(`[orchestrate] Eval decision: ${evalResult.decision}`);

		if (evalResult.decision === "APPROVE") {
			const csvPath = evalResult.csvPath || solverResult.csvPath;
			if (noSubmit) {
				console.log(`\n[orchestrate] DRY RUN (--no-submit) — eval approved ${csvPath}; skipping submission.`);
				process.exit(0);
			}
			// Never spend a try on predictions identical to the last submission.
			const csvHash = createHash("sha256").update(readFileSync(csvPath)).digest("hex");
			if (lastSubmittedHash && csvHash === lastSubmittedHash) {
				feedback = `Your new predictions are byte-identical to the last submission (platform score ${lastPlatformScore}). ` +
					`Re-submitting them would waste a try. Change the approach materially (features, model, preprocessing) before finishing.`;
				console.log(`[orchestrate] CSV unchanged since last submission — re-solving instead of submitting.`);
				continue;
			}

			console.log(`[orchestrate] Submitting: ${csvPath}`);

			// Step 3: Submit (this consumes a try)
			const submitResult = await runSubmitSession(taskId, csvPath);
			console.log(`[orchestrate] Submission result: ok=${submitResult.ok}, score=${submitResult.score}, tries_left=${submitResult.triesLeft}`);

			if (!submitResult.ok) {
				console.error(`[orchestrate] Submission failed: ${submitResult.error ?? "unknown error"}. Check logs.`);
				process.exit(3);
			}
			lastSubmittedHash = csvHash;
			lastPlatformScore = submitResult.score;
			const score = submitResult.score as number;

			if (score >= target) {
				console.log(`\n[orchestrate] SUCCESS — platform score ${score} >= target ${target}, tries_left=${submitResult.triesLeft}`);
				process.exit(0);
			}

			const triesLeft = submitResult.triesLeft ?? (MAX_SUBMISSIONS - getTaskMemory(taskId).tries_used);
			if (triesLeft <= 0) {
				console.log(`\n[orchestrate] DONE — platform score ${score} < target ${target}, but no submissions left.`);
				process.exit(0);
			}

			// Step 4: platform score below target — feed the real result back and re-solve.
			feedback = `Submission ${MAX_SUBMISSIONS - triesLeft} scored ${score} on the SmartLab platform (your local validation was ${solverResult.valScore}); ` +
				`target is >= ${target}. ${triesLeft} submission(s) left. ` +
				(solverResult.valScore - score > 0.02
					? `The gap between local and platform score means your validation split does not reflect the test data (distribution shift, leakage, or adversarial test examples) — inspect the test inputs and make the model more robust rather than tuning to the local split.`
					: `Improve the model materially (features, model class, preprocessing) — small hyperparameter tweaks will not move the score enough.`);
			console.log(`[orchestrate] Platform score ${score} < target ${target}. Re-solving with feedback.`);
			continue;
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
