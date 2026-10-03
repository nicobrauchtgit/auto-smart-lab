#!/usr/bin/env npx tsx
/**
 * SmartLab ML Challenge Orchestrator
 *
 * Drives the solver → check → submit loop for a single task. The solver's SOLVER_DONE line is the
 * decision to submit; a deterministic output check stops malformed output from spending one of the
 * 3 attempts. There is no LLM reviewer (removed 2026-10-03; see docs/AGENT.md).
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

/** meta.json of a task (written by fetch_units.py), found by short id. */
function findTaskMeta(taskId: string): { unit_slug?: string; submission?: "file" | "token"; dir: string } | null {
	if (!existsSync(UNITS_DIR)) return null;
	for (const unit of readdirSync(UNITS_DIR)) {
		const unitDir = join(UNITS_DIR, unit);
		if (!statSync(unitDir).isDirectory()) continue;
		for (const task of readdirSync(unitDir)) {
			const metaPath = join(unitDir, task, "meta.json");
			if (!existsSync(metaPath)) continue;
			try {
				const meta = JSON.parse(readFileSync(metaPath, "utf8"));
				if (meta.short_id === taskId) return { ...meta, dir: join(unitDir, task) };
			} catch { /* skip */ }
		}
	}
	return null;
}

/** Unit activation token for the VM's local service: SMARTLAB_ACTIVATION_TOKEN_<UNIT_SLUG> or SMARTLAB_ACTIVATION_TOKEN. */
function activationToken(unitSlug: string | undefined): string | undefined {
	const key = `SMARTLAB_ACTIVATION_TOKEN_${(unitSlug ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
	return process.env[key] || process.env.SMARTLAB_ACTIVATION_TOKEN || undefined;
}

/** Token tasks talk to the lab VM's local service; check it answers before spending a session on it. */
async function localServiceReachable(): Promise<boolean> {
	return new Promise((res) => {
		const req = httpRequest({ hostname: "127.0.0.1", port: 8000, path: "/", method: "GET", timeout: 5000 }, (r) => { r.resume(); res(true); });
		req.on("error", () => res(false));
		req.on("timeout", () => { req.destroy(); res(false); });
		req.end();
	});
}

import { ensureSolverScaffold } from "./scaffold.js";
import { runSolverSession } from "./solver_session.js";
import { checkCsv, checkToken } from "./output_check.js";
import { fetchTaskStatus, runSubmitSession } from "./submit_session.js";
import { collectConditions, describeConditions } from "./conditions.js";
import { getTaskMemory, updateTaskMemory } from "./memory_utils.js";
import { taskEvent, taskStatus } from "./status.js";
import { detectPythonRuntime } from "./runtime_env.js";
import { endRun, scoreRun, stage, startRun } from "./langfuse.js";
import type { SolverResult } from "./solver_session.js";

const MAX_SUBMISSIONS = 3;
/** Platform score at or above which we stop iterating. Override with --target. */
const DEFAULT_TARGET = 0.97;
/**
 * How many consecutive solver results may reproduce the last submission byte-for-byte before the task
 * stops (keeping its remaining attempts). Re-solving is free, so without a cap a model that keeps
 * producing the same predictions loops indefinitely (documents3, 2026-10-02: 12 times, ~3 h).
 * Override with --max-unchanged.
 */
const DEFAULT_MAX_UNCHANGED = 3;
/**
 * Consecutive solver sessions without a submittable result (killed at the cap, tool loop, no
 * SOLVER_DONE line, or output that fails the check) before the task stops.
 */
const MAX_SOLVER_FAILURES = 3;
const AGENT_DIR = join(PROJECT_ROOT, "agent");

/**
 * Resolve a path an agent reported. Relative paths are ambiguous: the solver's shell starts in the
 * repo root, but `smartlab_agent.py` runs in agent/, so a module's relative DEFAULT_SUBMISSION lands
 * under agent/. Prefer whichever exists (attacks2 smoke test, 2026-10-03: a valid CSV was missed).
 */
function resolveReported(p: string): string {
	if (!p || isAbsolute(p)) return p;
	const fromRoot = resolve(PROJECT_ROOT, p);
	const fromAgent = resolve(AGENT_DIR, p);
	return existsSync(fromRoot) || !existsSync(fromAgent) ? fromRoot : fromAgent;
}

function usage(): never {
	console.error("Usage: npx tsx agent/run/orchestrate.ts <task_id|list> [--model <id>] [--task-url <url>] [--secure] [--no-submit] [--target <score>] [--solver-timeout <minutes>] [--max-attempts <n>] [--max-cost <usd>] [--max-unchanged <n>]");
	console.error(`Exit codes: 0 done (target reached, no attempts left, dry run or attempt cap), 1 no attempts before start, 2 solver failed (${MAX_SOLVER_FAILURES} sessions in a row without a submittable result), 3 submission failed (or the platform refused ${MAX_SOLVER_FAILURES} uploads in a row), 4 model API daily/monthly quota exhausted, 5 cost budget (--max-cost USD) exhausted, 7 solver kept reproducing the last submission (--max-unchanged, default 3), 9 token task without the VM's local service, 99 fatal (6 and 8 belonged to the removed eval agent)`);
	console.error("Required env: LAB_USER, LAB_PASS");
	console.error("Examples:");
	console.error("  npm run solve list                    # show all available task IDs");
	console.error("  npm run solve spam3                   # solve task spam3");
	console.error("  npm run solve spam3 -- --model gwdg/devstral-2-123b-instruct-2512");
	console.error("  npm run solve spam1 -- --no-submit    # run the solver + output check, skip the real submission");
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
	const maxUnchangedArg = takeArg("--max-unchanged");
	const maxUnchanged = maxUnchangedArg !== undefined ? Number(maxUnchangedArg) : DEFAULT_MAX_UNCHANGED;
	if (!Number.isInteger(maxUnchanged) || maxUnchanged < 1) usage();
	const maxAttemptsArg = takeArg("--max-attempts");
	const maxAttemptsThisRun = maxAttemptsArg !== undefined ? Number(maxAttemptsArg) : MAX_SUBMISSIONS;
	if (!Number.isFinite(maxAttemptsThisRun) || maxAttemptsThisRun < 0) usage();
	const targetArg = takeArg("--target");
	const target = targetArg !== undefined ? Number(targetArg) : DEFAULT_TARGET;
	if (!Number.isFinite(target)) usage();
	const taskId = args[0];
	if (!taskId) usage();
	// Anything left over is an unknown flag or a typo: refuse rather than ignore it (a mistyped
	// --no-submit would otherwise spend a real attempt).
	if (args.length > 1) {
		console.error(`[orchestrate] Unknown argument(s): ${args.slice(1).join(" ")}`);
		usage();
	}

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

	// Attempts already made on the platform (earlier runs, or by hand): sync them into memory so the
	// solver's first message and the attempt checks use the platform's numbers, not a reset memory.
	/** Platform results for this task, oldest first; `local` is known only for submissions of this run. */
	const history: { local: number | null; platform: number | null }[] = [];
	try {
		const st = await fetchTaskStatus(process.env.SMARTLAB_TASK_URL!, /^(1|true|yes|on)$/i.test(process.env.LAB_INSECURE_TLS ?? ""));
		if (st.attemptsUsed !== null) {
			const m = getTaskMemory(taskId);
			if (st.attemptsUsed > m.tries_used || st.bestScore !== null) {
				updateTaskMemory(taskId, { tries_used: Math.max(st.attemptsUsed, m.tries_used), tries_left: MAX_SUBMISSIONS - Math.max(st.attemptsUsed, m.tries_used), ...(st.bestScore !== null ? { best_score: st.bestScore } : {}) });
			}
			for (const sc of [...st.scores].reverse()) history.push({ local: null, platform: sc });
			console.log(`[orchestrate] Platform: ${st.attemptsUsed}/${st.attemptsMax} attempts used${st.scores.length ? `, scores ${st.scores.join(", ")}` : ""}`);
		}
	} catch (err) {
		console.warn(`[orchestrate] Could not read the task page for prior attempts (${err instanceof Error ? err.message : err}); using memory.`);
	}
	const initialMem = getTaskMemory(taskId);
	if (initialMem.tries_used >= MAX_SUBMISSIONS) {
		console.error(`[orchestrate] No submissions left for task ${taskId} (${initialMem.tries_used}/${MAX_SUBMISSIONS} used).`);
		process.exit(1);
	}

	// How the task is submitted (from the task page, via fetch_units.py): a CSV upload or a token.
	const meta = findTaskMeta(taskId);
	const submission: "file" | "token" = meta?.submission === "token" ? "token" : "file";
	const unitToken = submission === "token" ? activationToken(meta?.unit_slug) : undefined;
	if (submission === "token") {
		console.log(`[orchestrate] Token task: solved against the local service at 127.0.0.1:8000; unit activation token ${unitToken ? "configured" : "NOT configured"}`);
		if (!(await localServiceReachable())) {
			console.error(`[orchestrate] ${taskId} is a token task but nothing answers on 127.0.0.1:8000. It needs the lab VM (scripts/vm/remote.sh). Stopping.`);
			process.exit(9);
		}
	}

	// Step 0: Ensure a solver module exists (scaffold if needed)
	await ensureSolverScaffold(taskId);

	let feedback: string | undefined;
	let iteration = 0;
	let solverFailures = 0;
	let attemptsThisRun = 0;
	let lastSubmittedHash: string | undefined;
	let unchangedStreak = 0;
	/** Consecutive uploads the platform refused without counting an attempt, and the last refused output. */
	let platformRejects = 0;
	let lastRejectedHash: string | undefined;
	let lastPlatformScore: number | null = null;
	console.log(`[orchestrate] Target platform score: ${target}`);
	const py = detectPythonRuntime();
	console.log(`[orchestrate] Python runtime: ${py ? `${py.executable} ${py.version}, ${py.packages.length} third-party packages${py.inVirtualenv ? ", virtualenv" : ""}` : "not detected"}`);
	const conditions = collectConditions({
		target, maxAttempts: maxAttemptsThisRun, maxUnchanged, maxSolverFailures: MAX_SOLVER_FAILURES, noSubmit, submission,
		solverTimeoutMin: Math.round(Number(process.env.PI_SESSION_TIMEOUT_MS || 0) / 60000) || null,
		maxCostUsd: process.env.PI_MAX_COST_USD ? Number(process.env.PI_MAX_COST_USD) : null,
	});
	console.log(`[orchestrate] Conditions: ${describeConditions(conditions)}`);
	taskStatus({ task: taskId, model: process.env.PI_MODEL ?? null, target, noSubmit, startedAt: new Date().toISOString(), phase: "starting", iteration: 0, events: [], session: null, result: null,
		python: py ? { executable: py.executable, version: py.version, packages: py.packages.length, virtualenv: py.inVirtualenv } : null,
		conditions, submissions: [] }, { reset: true });
	// Record how the process ended, whatever the path (process.exit is used throughout).
	process.on("exit", (code) => taskStatus({ phase: "exited", exitCode: code, endedAt: new Date().toISOString() }));

	// Langfuse (optional): this run is one session; each stage below is a trace in it.
	startRun({ taskId, model: process.env.PI_MODEL, metadata: {
		target: String(target), no_submit: String(noSubmit), submission,
		commit: conditions.git.commit ?? "?", dirty: String(conditions.git.dirty.length),
		...Object.fromEntries(Object.entries(conditions.prompts).map(([k, v]) => [`prompt_${k.replace(/\.md$/, "")}`, v])),
		host: conditions.host, python: conditions.python?.version ?? "none",
		caps: JSON.stringify(conditions.caps),
	} });
	/** This run's submissions, for the status file and the batch summary. */
	const submissions: { iteration: number; local: number | null; platform: number | null; triesLeft: number | null }[] = [];
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

		// Step 1: Solver. Its SOLVER_DONE line is the decision to submit.
		let solverResult: SolverResult;
		let problem: string | undefined;
		try {
			taskStatus({ phase: "solver" });
			solverResult = await stage("solver", { iteration, input: { task: taskId, feedback: feedback ?? null } }, async (t) => {
				const r = await runSolverSession(taskId, feedback, { submission, activationToken: unitToken, attemptsUsed: mem.tries_used, attemptsMax: MAX_SUBMISSIONS, history });
				t.output(r);
				if (r.valScore !== null) t.score("local_val_score", r.valScore);
				return r;
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/cost budget exhausted/i.test(msg)) {
				console.error(`[orchestrate] ${msg}. Stopping this task.`);
				await exitRun(5, "cost_budget_exhausted");
			}
			if (!/timed out|degenerate tool loop/i.test(msg)) throw err;
			problem = /timed out/i.test(msg) ? "was killed at its time cap" : "was aborted for repeating the same tool call (degenerate tool loop)";
			solverResult = { valScore: null, csvPath: "", approach: "" };
		}
		if (!problem && !(submission === "token" ? solverResult.token : solverResult.csvPath)) problem = "ended without the SOLVER_DONE line";

		// Step 2: deterministic output check. Nothing undeclared or malformed is submitted; the
		// solver gets the facts and another session (capped by MAX_SOLVER_FAILURES).
		const csvPath = resolveReported(solverResult.csvPath);
		const check = problem ? null
			: submission === "token" ? checkToken(solverResult.token)
			: checkCsv(csvPath);
		if (!check || !check.ok) {
			solverFailures++;
			const fact = check ? check.message : `Your previous session ${problem}; nothing was submitted. Your files are still in place.`;
			taskEvent(check ? `output check failed: ${check.message.slice(0, 140)}` : `solver ${problem}`);
			console.warn(`[orchestrate] ${fact}`);
			if (solverFailures >= MAX_SOLVER_FAILURES) {
				console.error(`[orchestrate] ${solverFailures} solver sessions in a row without a submittable result. Stopping.`);
				await exitRun(2, "solver_failed");
			}
			feedback = `${fact} That was session ${solverFailures} of ${MAX_SOLVER_FAILURES} in a row without a submittable result; at ${MAX_SOLVER_FAILURES} the task stops.`;
			continue;
		}
		solverFailures = 0;
		const what = submission === "token" ? "token" : csvPath;
		console.log(`[orchestrate] Solver declared ${what}: local ${solverResult.valScore ?? "none"}; output check: ${check.message}`);
		taskStatus({ localScore: solverResult.valScore });
		taskEvent(`solver declared: local ${solverResult.valScore ?? "none"}; ${check.message}`);

		if (noSubmit) {
			console.log(`\n[orchestrate] DRY RUN (--no-submit) — solver declared ${what}; output check passed; skipping submission.`);
			await exitRun(0, "dry_run");
		}
		// Never spend a try on output identical to the last submission.
		const outHash = createHash("sha256").update(submission === "token" ? solverResult.token! : readFileSync(csvPath)).digest("hex");
		if (lastSubmittedHash && outHash === lastSubmittedHash) {
			unchangedStreak++;
			taskEvent(`output identical to last submission (${unchangedStreak}/${maxUnchanged})`);
			if (unchangedStreak >= maxUnchanged) {
				console.log(`\n[orchestrate] DONE — ${unchangedStreak} consecutive solver results reproduced the last submission; stopping with remaining attempts unused.`);
				await exitRun(7, "no_new_predictions");
			}
			feedback = `Your new output is byte-identical to the last submission (platform score ${lastPlatformScore}); it was not re-submitted. ` +
				`This is identical result ${unchangedStreak} of ${maxUnchanged} in a row; at ${maxUnchanged} the task stops without using the remaining attempts.`;
			console.log(`[orchestrate] Output unchanged since last submission (${unchangedStreak}/${maxUnchanged}) — re-solving instead of submitting.`);
			continue;
		}
		unchangedStreak = 0;
		if (outHash === lastRejectedHash) {
			platformRejects++;
			if (platformRejects >= MAX_SOLVER_FAILURES) {
				console.error(`[orchestrate] ${platformRejects} results in a row were refused by the platform or identical to a refused upload. Stopping.`);
				await exitRun(3, "platform_rejected");
			}
			feedback = `Your new output is byte-identical to the upload the platform refused; it was not uploaded again. ` +
				`That was result ${platformRejects} of ${MAX_SOLVER_FAILURES} in a row without an accepted upload; at ${MAX_SOLVER_FAILURES} the task stops.`;
			taskEvent(`output identical to the refused upload (${platformRejects}/${MAX_SOLVER_FAILURES})`);
			continue;
		}

		if (attemptsThisRun >= maxAttemptsThisRun) {
			console.log(`\n[orchestrate] DONE — attempt cap for this run reached (${attemptsThisRun}/${maxAttemptsThisRun}); not submitting ${what}.`);
			await exitRun(0, "attempt_cap_reached");
		}
		console.log(`[orchestrate] Submitting: ${what}`);

		// Step 3: Submit (this consumes a try)
		taskStatus({ phase: "submit" });
		const submitResult = await stage("submit", { iteration, input: submission === "token" ? { token: solverResult.token } : { csv: csvPath } }, async (t) => {
			const r = await runSubmitSession(taskId, submission === "token" ? { token: solverResult.token! } : { csvPath });
			t.output(r);
			if (r.score !== null) t.score("platform_score", r.score);
			return r;
		});
		if (submitResult.score !== null && (bestPlatformScore === null || submitResult.score > bestPlatformScore)) bestPlatformScore = submitResult.score;
		submissions.push({ iteration, local: solverResult.valScore, platform: submitResult.score, triesLeft: submitResult.triesLeft });
		if (submitResult.ok) history.push({ local: solverResult.valScore, platform: submitResult.score });
		taskStatus({ result: { platformScore: submitResult.score, triesLeft: submitResult.triesLeft, ok: submitResult.ok }, submissions });
		taskEvent(`submitted: platform ${submitResult.score}, ${submitResult.triesLeft} attempt(s) left`);
		console.log(`[orchestrate] Submission result: ok=${submitResult.ok}, score=${submitResult.score}, tries_left=${submitResult.triesLeft}`);

		if (submitResult.rejected) {
			// The platform's grader refused the file and did not count an attempt: a student sees the
			// message on the task page, so the solver gets it verbatim.
			platformRejects++;
			lastRejectedHash = outHash;
			taskEvent(`platform refused the upload, no attempt counted: ${String(submitResult.error).slice(0, 120)}`);
			if (platformRejects >= MAX_SOLVER_FAILURES) {
				console.error(`[orchestrate] The platform refused ${platformRejects} uploads in a row. Stopping.`);
				await exitRun(3, "platform_rejected");
			}
			feedback = `The platform refused your upload without counting an attempt. Its message: "${submitResult.error}". ` +
				`${submitResult.triesLeft ?? "?"} attempt(s) left. That was upload ${platformRejects} of ${MAX_SOLVER_FAILURES} in a row refused; at ${MAX_SOLVER_FAILURES} the task stops.`;
			console.log(`[orchestrate] Upload refused by the platform (${platformRejects}/${MAX_SOLVER_FAILURES}) — re-solving with its message.`);
			continue;
		}
		platformRejects = 0;
		if (!submitResult.ok) {
			console.error(`[orchestrate] Submission failed: ${submitResult.error ?? "unknown error"}. Check logs.`);
			await exitRun(3, "submission_failed");
		}
		attemptsThisRun++;
		lastSubmittedHash = outHash;
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
		feedback = `Submission ${MAX_SUBMISSIONS - triesLeft} scored ${score} on the SmartLab platform; your local validation score was ${solverResult.valScore ?? "not reported"}. ` +
			`The target is >= ${target}. ${triesLeft} submission(s) left; identical output will not be re-submitted.`;
		console.log(`[orchestrate] Platform score ${score} < target ${target}. Re-solving with feedback.`);
	}
}

main().catch(async (err) => {
	console.error("[orchestrate] Fatal error:", err);
	await scoreRun("outcome", "fatal", String(err).slice(0, 500));
	await endRun();
	process.exit(99);
});
