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

/** Thrown when the API key's daily or monthly quota is used up: nothing can run until it resets. */
class QuotaExhaustedError extends Error {}

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
					if (r.statusCode === 429) {
						const h = (k: string) => { const v = r.headers[k]; return v === undefined ? undefined : Number(Array.isArray(v) ? v[0] : v); };
						const left = { minute: h("x-ratelimit-remaining-minute"), hour: h("x-ratelimit-remaining-hour"), day: h("x-ratelimit-remaining-day"), month: h("x-ratelimit-remaining-month") };
						const resetS = h("retry-after") ?? h("ratelimit-reset");
						const window = left.month === 0 ? "monthly" : left.day === 0 ? "daily" : undefined;
						if (window) {
							const when = resetS !== undefined ? new Date(Date.now() + resetS * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown";
							rej(new QuotaExhaustedError(`${providerName} API ${window} quota exhausted (remaining: ${JSON.stringify(left)}); resets ${when}`));
							return;
						}
					}
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
import { taskEvent, taskStatus } from "./status.js";
import { detectPythonRuntime } from "./runtime_env.js";
import { endRun, scoreRun, stage, startRun } from "./langfuse.js";
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
	// The CLI ran with cwd=agent/; a module with a relative output path writes relative to that.
	const csvPath = isAbsolute(sm[1]) ? sm[1] : resolve(AGENT_DIR, sm[1]);
	if (!existsSync(csvPath)) { console.warn(`[salvage] solve reported ${csvPath} but it does not exist`); return null; }
	const approach = "(salvaged: solver session ended early; predictions produced by running its module directly)";
	updateTaskMemory(taskId, { last_val_score: valScore, last_submission_csv: csvPath, approach });
	console.log(`[salvage] ok: val_score=${valScore}, csv=${csvPath}`);
	return { valScore, csvPath, approach };
}

function usage(): never {
	console.error("Usage: npx tsx agent/run/orchestrate.ts <task_id|list> [--model <id>] [--task-url <url>] [--secure] [--no-submit] [--target <score>] [--solver-timeout <minutes>] [--max-attempts <n>] [--max-cost <usd>]");
	console.error("Exit codes: 0 done (target reached, no attempts left, dry run or attempt cap), 1 no attempts before start, 2 solver failed, 3 submission failed, 4 model API daily/monthly quota exhausted, 5 cost budget (--max-cost USD) exhausted, 6 eval session failed twice, 99 fatal");
	console.error("Required env: LAB_USER, LAB_PASS");
	console.error("Examples:");
	console.error("  npm run solve list                    # show all available task IDs");
	console.error("  npm run solve spam3                   # solve task spam3");
	console.error("  npm run solve spam3 -- --model gwdg/devstral-2-123b-instruct-2512");
	console.error("  npm run solve spam1 -- --no-submit    # run solver+eval, skip the real submission");
	console.error("  npm run solve spam2 -- --target 0.95  # keep re-solving + submitting until the platform score >= 0.95");
	console.error("TLS: the lab uses a self-signed certificate, so verification is OFF by default; pass --secure (or LAB_INSECURE_TLS=0) to verify.");
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
	takeFlag("--insecure"); // accepted for backwards compatibility; it is the default
	const secure = takeFlag("--secure");
	const noSubmit = takeFlag("--no-submit");
	const maxCostArg = takeArg("--max-cost");
	if (maxCostArg !== undefined) {
		const usd = Number(maxCostArg);
		if (!Number.isFinite(usd) || usd <= 0) usage();
		process.env.PI_MAX_COST_USD = String(usd);
	}
	const solverTimeoutArg = takeArg("--solver-timeout");
	if (solverTimeoutArg !== undefined) {
		const mins = Number(solverTimeoutArg);
		if (!Number.isFinite(mins) || mins <= 0) usage();
		process.env.PI_SESSION_TIMEOUT_MS = String(Math.round(mins * 60 * 1000));
	}
	const maxAttemptsArg = takeArg("--max-attempts");
	const maxAttemptsThisRun = maxAttemptsArg !== undefined ? Number(maxAttemptsArg) : MAX_SUBMISSIONS;
	if (!Number.isFinite(maxAttemptsThisRun) || maxAttemptsThisRun < 0) usage();
	const targetArg = takeArg("--target");
	const target = targetArg !== undefined ? Number(targetArg) : DEFAULT_TARGET;
	if (!Number.isFinite(target)) usage();
	const taskId = args[0];
	if (!taskId) usage();

	// List available tasks
	if (taskId === "list") {
		const indexPath = join(UNITS_DIR, "index.json");
		if (!existsSync(indexPath)) {
			console.error("No units/index.json found. Run: python3 agent/setup/fetch_units.py");
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
			if (err instanceof QuotaExhaustedError) {
				console.error(`[orchestrate] ${err.message}. Nothing can run until then; stopping.`);
				process.exit(4);
			}
			// Health check failed — warn but continue; the PI SDK uses its own auth flow
			console.warn(`[orchestrate] Model pre-check warning: ${err}`);
			console.warn(`  Continuing anyway — the SDK may still be able to use this model.`);
		}
	}
	if (taskUrl) { process.env.SMARTLAB_TASK_URL = taskUrl; }
	// The lab serves a self-signed certificate: skip verification unless --secure / LAB_INSECURE_TLS=0.
	if (secure) process.env.LAB_INSECURE_TLS = "0";
	else if (!process.env.LAB_INSECURE_TLS) process.env.LAB_INSECURE_TLS = "1";

	// Auto-resolve task URL from units/<unit>/<task>/meta.json if not set
	if (!process.env.SMARTLAB_TASK_URL) {
		const found = findTaskUrl(taskId);
		if (found) {
			process.env.SMARTLAB_TASK_URL = found;
			console.log(`[orchestrate] Resolved task URL from meta.json: ${found}`);
		} else {
			console.error(`[orchestrate] Could not resolve task URL for '${taskId}'.`);
			console.error(`  Either set SMARTLAB_TASK_URL in the environment, pass --task-url <url>,`);
			console.error(`  or run: python3 agent/setup/fetch_units.py`);
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
	let attemptsThisRun = 0;
	let lastSubmittedHash: string | undefined;
	let lastPlatformScore: number | null = null;
	console.log(`[orchestrate] Target platform score: ${target}`);
	const py = detectPythonRuntime();
	console.log(`[orchestrate] Python runtime: ${py ? `${py.executable} ${py.version}, ${py.packages.length} third-party packages${py.inVirtualenv ? ", virtualenv" : ""}` : "not detected"}`);
	taskStatus({ task: taskId, model: process.env.PI_MODEL ?? null, target, noSubmit, startedAt: new Date().toISOString(), phase: "starting", iteration: 0, events: [], session: null, result: null,
		python: py ? { executable: py.executable, version: py.version, packages: py.packages.length, virtualenv: py.inVirtualenv } : null }, { reset: true });
	// Record how the process ended, whatever the path (process.exit is used throughout).
	process.on("exit", (code) => taskStatus({ phase: "exited", exitCode: code, endedAt: new Date().toISOString() }));

	// Langfuse (optional): this run is one session; each stage below is a trace in it.
	startRun({ taskId, model: process.env.PI_MODEL, metadata: { target: String(target), no_submit: String(noSubmit) } });
	let bestPlatformScore: number | null = null;
	/** End the run: session-level scores, flush traces, then exit. */
	async function exitRun(code: number, outcome: string): Promise<never> {
		if (bestPlatformScore !== null) void scoreRun("platform_score", bestPlatformScore, `best of ${attemptsThisRun} submission(s) this run`);
		void scoreRun("submissions", attemptsThisRun);
		await scoreRun("outcome", outcome, `exit code ${code}`);
		await endRun();
		process.exit(code);
	}

	while (true) {
		iteration++;
		console.log(`\n[orchestrate] === Iteration ${iteration} ===`);
		taskStatus({ iteration });

		// Re-check submission budget (updated by submit sessions writing to memory)
		const mem = getTaskMemory(taskId);
		if (mem.tries_used >= MAX_SUBMISSIONS) {
			console.error(`[orchestrate] No submissions left (${mem.tries_used}/${MAX_SUBMISSIONS} used). Stopping.`);
			await exitRun(1, "no_attempts_left");
		}
		console.log(`[orchestrate] Submissions: ${mem.tries_used}/${MAX_SUBMISSIONS} used, ${mem.tries_left ?? MAX_SUBMISSIONS - mem.tries_used} remaining`);

		// Step 1: Solver
		let solverResult: SolverResult;
		let solverProblem: string | undefined;
		try {
			taskStatus({ phase: "solver" });
			solverResult = await stage("solver", { iteration, input: { task: taskId, feedback: feedback ?? null } }, async (t) => {
				const r = await runSolverSession(taskId, feedback);
				t.output(r);
				t.score("local_val_score", r.valScore);
				return r;
			});
			console.log(`[orchestrate] Solver done: val_score=${solverResult.valScore}, csv=${solverResult.csvPath}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/cost budget exhausted/i.test(msg)) {
				console.error(`[orchestrate] ${msg}. Stopping this task (no salvage: the budget is spent).`);
				await exitRun(5, "cost_budget_exhausted");
			}
			if (!/timed out|degenerate tool loop/i.test(msg)) throw err;
			console.warn(`[orchestrate] Solver session ended early: ${msg}`);
			solverProblem = /timed out/i.test(msg) ? "timed out" : "was aborted (degenerate tool loop)";
			solverResult = { valScore: 0, csvPath: "", approach: "" };
		}

		let csvAbsPath = solverResult.csvPath
			? isAbsolute(solverResult.csvPath) ? solverResult.csvPath : resolve(PROJECT_ROOT, solverResult.csvPath)
			: "";
		if (!csvAbsPath || !existsSync(csvAbsPath)) {
			solverProblem ??= "ended without a prediction CSV";
			taskStatus({ phase: "salvage" });
			taskEvent(`solver ${solverProblem}; salvaging`);
			const salvaged = await stage("salvage", { iteration, input: { reason: solverProblem } }, async (t) => {
				const r = salvageSolver(taskId);
				t.output(r ?? { salvaged: false });
				if (r) t.score("local_val_score", r.valScore);
				return r;
			});
			if (salvaged) {
				solverResult = salvaged;
				csvAbsPath = isAbsolute(salvaged.csvPath) ? salvaged.csvPath : resolve(PROJECT_ROOT, salvaged.csvPath);
			} else {
				solverFailures++;
				if (solverFailures >= MAX_SOLVER_FAILURES) {
					console.error(`[orchestrate] Solver ${solverProblem} ${solverFailures} time(s) and nothing could be salvaged. Stopping.`);
					await exitRun(2, "solver_failed");
				}
				feedback = `Your previous session ${solverProblem} before producing predictions. This is the last session for this task.`;
				console.log(`[orchestrate] Nothing to salvage — re-running solver with finish-first instructions.`);
				continue;
			}
		}
		solverResult.csvPath = csvAbsPath;

		// Step 2: Eval
		taskStatus({ phase: "eval", localScore: solverResult.valScore });
		taskEvent(`solver done: local ${solverResult.valScore}`);
		let evalResult: Awaited<ReturnType<typeof runEvalSession>> | undefined;
		// An eval session that loops or times out must not crash the task: retry it once, then stop
		// the task without submitting (never submit without an approval).
		for (let evalTry = 1; evalTry <= 2 && !evalResult; evalTry++) {
			try {
				evalResult = await stage("eval", { iteration, input: { task: taskId, local_val_score: solverResult.valScore, attempt: evalTry } }, async (t) => {
					const r = await runEvalSession(taskId);
					t.output(r);
					t.score("eval_decision", r.decision, r.feedback || undefined);
					return r;
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/cost budget exhausted/i.test(msg)) { console.error(`[orchestrate] ${msg}. Stopping this task.`); await exitRun(5, "cost_budget_exhausted"); }
				if (!/timed out|degenerate tool loop/i.test(msg)) throw err;
				taskEvent(`eval ended early (${/timed out/i.test(msg) ? "timeout" : "tool loop"}), try ${evalTry}/2`);
				if (evalTry === 2) {
					console.error(`[orchestrate] Eval session ended early twice (${msg}). Stopping this task without submitting.`);
					await exitRun(6, "eval_failed");
				}
				console.warn(`[orchestrate] Eval session ended early: ${msg}. Retrying the eval once.`);
			}
		}
		if (!evalResult) throw new Error("unreachable: eval produced no result");
		console.log(`[orchestrate] Eval decision: ${evalResult.decision}`);
		taskEvent(`eval: ${evalResult.decision}${evalResult.feedback ? ` — ${evalResult.feedback.slice(0, 120)}` : ""}`);

		if (evalResult.decision === "APPROVE") {
			const csvPath = evalResult.csvPath || solverResult.csvPath;
			if (noSubmit) {
				console.log(`\n[orchestrate] DRY RUN (--no-submit) — eval approved ${csvPath}; skipping submission.`);
				await exitRun(0, "dry_run_approved");
			}
			// Never spend a try on predictions identical to the last submission.
			const csvHash = createHash("sha256").update(readFileSync(csvPath)).digest("hex");
			if (lastSubmittedHash && csvHash === lastSubmittedHash) {
				feedback = `Your new predictions are byte-identical to the last submission (platform score ${lastPlatformScore}); they were not re-submitted.`;
				console.log(`[orchestrate] CSV unchanged since last submission — re-solving instead of submitting.`);
				continue;
			}

			if (attemptsThisRun >= maxAttemptsThisRun) {
				console.log(`\n[orchestrate] DONE — attempt cap for this run reached (${attemptsThisRun}/${maxAttemptsThisRun}); eval approved ${csvPath} but not submitting.`);
				await exitRun(0, "attempt_cap_reached");
			}
			console.log(`[orchestrate] Submitting: ${csvPath}`);

			// Step 3: Submit (this consumes a try)
			taskStatus({ phase: "submit" });
			const submitResult = await stage("submit", { iteration, input: { csv: csvPath } }, async (t) => {
				const r = await runSubmitSession(taskId, csvPath);
				t.output(r);
				if (r.score !== null) t.score("platform_score", r.score);
				return r;
			});
			if (submitResult.score !== null && (bestPlatformScore === null || submitResult.score > bestPlatformScore)) bestPlatformScore = submitResult.score;
			taskStatus({ result: { platformScore: submitResult.score, triesLeft: submitResult.triesLeft, ok: submitResult.ok } });
			taskEvent(`submitted: platform ${submitResult.score}, ${submitResult.triesLeft} attempt(s) left`);
			console.log(`[orchestrate] Submission result: ok=${submitResult.ok}, score=${submitResult.score}, tries_left=${submitResult.triesLeft}`);

			if (!submitResult.ok) {
				console.error(`[orchestrate] Submission failed: ${submitResult.error ?? "unknown error"}. Check logs.`);
				await exitRun(3, "submission_failed");
			}
			attemptsThisRun++;
			lastSubmittedHash = csvHash;
			lastPlatformScore = submitResult.score;
			const score = submitResult.score as number;

			if (score >= target) {
				console.log(`\n[orchestrate] SUCCESS — platform score ${score} >= target ${target}, tries_left=${submitResult.triesLeft}`);
				await exitRun(0, "target_reached");
			}

			const triesLeft = submitResult.triesLeft ?? (MAX_SUBMISSIONS - getTaskMemory(taskId).tries_used);
			if (triesLeft <= 0) {
				console.log(`\n[orchestrate] DONE — platform score ${score} < target ${target}, but no submissions left.`);
				await exitRun(0, "below_target_no_attempts_left");
			}

			// Step 4: platform score below target — feed the real result back and re-solve.
			// Facts only — no advice on what to change (this agent is deliberately un-coached).
			feedback = `Submission ${MAX_SUBMISSIONS - triesLeft} scored ${score} on the SmartLab platform; your local validation score was ${solverResult.valScore}. ` +
				`The target is >= ${target}. ${triesLeft} submission(s) left; identical predictions will not be re-submitted.`;
			console.log(`[orchestrate] Platform score ${score} < target ${target}. Re-solving with feedback.`);
			continue;
		}

		// REJECT — re-solve is free (only submissions count)
		feedback = evalResult.feedback;
		console.log(`[orchestrate] Re-solving with feedback: "${feedback}"`);
	}
}

main().catch(async (err) => {
	console.error("[orchestrate] Fatal error:", err);
	await scoreRun("outcome", "fatal", String(err).slice(0, 500));
	await endRun();
	process.exit(99);
});
