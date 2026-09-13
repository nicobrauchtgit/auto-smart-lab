#!/usr/bin/env npx tsx
/**
 * Solve every task of every unit on the lab, unattended.
 *
 *   npm run solve-units -- [--model <id>] [--target <s>] [--no-submit] [--secure] [...]
 *
 * What it does, in order:
 *   1. Fetch units from the lab if units/index.json is missing (or --refresh).
 *   2. Reset task state so the run starts from scratch (--reset once|each|none, default once).
 *   3. For each task (unit order), read its lab page and SKIP it when
 *        - all attempts are used,
 *        - the best existing score already meets --target (unless --retry-solved),
 *        - it is not open (before start date / after deadline).
 *   4. Otherwise run the per-task orchestrator (agent/run/orchestrate.ts) as a subprocess,
 *      one task at a time (the GWDG API budget makes parallel runs pointless), and continue
 *      with the next task whatever the outcome.
 *   5. Print a results table; write logs/solve-units/<stamp>/{<task>.log,summary.json}.
 *
 * The per-task orchestrator is the unit of failure: a broken task never takes down the batch.
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTaskStatus, SimpleClient, type TaskStatus } from "./submit_session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");
const INDEX_PATH = join(UNITS_DIR, "index.json");
const FETCH_SCRIPT = join(PROJECT_ROOT, "agent", "setup", "fetch_units.py");
const RESET_SCRIPT = join(PROJECT_ROOT, "agent", "setup", "reset_state.py");
const ORCHESTRATE = join(HERE, "orchestrate.ts");
const TSX = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
const DEFAULT_TARGET = 0.97;

type Outcome = "solved" | "attempts-exhausted" | "attempt-cap" | "below-target" | "dry-run" | "solver-failed" | "submit-failed" | "fatal" | "skipped";

interface TaskResult {
	id: string;
	url: string;
	title: string;
	outcome: Outcome;
	reason: string;
	before: TaskStatus | null;
	after: TaskStatus | null;
	exitCode: number | null;
	minutes: number;
	log: string | null;
}

function usage(): never {
	console.error(`Usage: npm run solve-units -- [--model <id>] [--target <score>] [--solver-timeout <min>]
                              [--max-attempts <n>] [--no-submit] [--refresh] [--reset once|each|none]
                              [--only spam1,spam3] [--retry-solved] [--plan]
  --plan          only print what would run (fetch + status check), solve nothing
  --refresh       re-fetch units from the lab even if units/index.json exists
  --reset         once (default): full reset before the first task; each: per-task reset; none
  --only          comma-separated task ids to consider
  --retry-solved  run tasks whose best platform score already meets --target
  --max-attempts  attempts one task may spend in this run (default 3)
  --secure        verify the lab's TLS certificate (off by default: the lab is self-signed)
Other flags are passed through to the per-task orchestrator.`);
	process.exit(1);
}

function fmtScore(x: number | null | undefined): string { return x === null || x === undefined ? "-" : x.toFixed(4); }
function fmtDate(d: Date | null): string { return d ? d.toISOString().slice(0, 10) : "-"; }
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s.padEnd(n); }

function runPython(script: string, args: string[], label: string): boolean {
	console.log(`[units] ${label}: python3 ${script.replace(PROJECT_ROOT + "/", "")} ${args.join(" ")}`);
	const r = spawnSync("python3", [script, ...args], { cwd: dirname(script), stdio: "inherit" });
	if (r.status !== 0) { console.error(`[units] ${label} failed (exit ${r.status})`); return false; }
	return true;
}

/** Run the per-task orchestrator, streaming its output to the console and to a log file. */
function runOrchestrator(taskId: string, args: string[], logPath: string): Promise<number | null> {
	return new Promise((res) => {
		const log = createWriteStream(logPath);
		const child = spawn(TSX, [ORCHESTRATE, taskId, ...args], { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const tee = (chunk: Buffer) => { process.stdout.write(chunk); log.write(chunk); };
		child.stdout.on("data", tee);
		child.stderr.on("data", tee);
		child.on("close", (code) => { log.end(); res(code); });
		child.on("error", (err) => { log.write(`spawn error: ${err}\n`); log.end(); res(null); });
	});
}

function classify(before: TaskStatus | null, after: TaskStatus | null, exitCode: number | null, target: number, noSubmit: boolean, maxAttempts: number): [Outcome, string] {
	if (exitCode === 99 || exitCode === null) return ["fatal", "orchestrator crashed"];
	if (exitCode === 2) return ["solver-failed", "solver produced no usable predictions"];
	if (exitCode === 3) return ["submit-failed", "upload or result polling failed"];
	if (noSubmit) return ["dry-run", "eval approved, submission skipped (--no-submit)"];
	const best = after?.bestScore ?? null;
	const spent = (after?.attemptsUsed ?? 0) - (before?.attemptsUsed ?? 0);
	if (best !== null && best >= target) return ["solved", `best platform score ${fmtScore(best)} >= ${target}`];
	if (after?.exhausted) return ["attempts-exhausted", `all ${after.attemptsMax} attempts used, best ${fmtScore(best)}`];
	if (spent >= maxAttempts) return ["attempt-cap", `spent ${spent} attempt(s) this run (cap ${maxAttempts}), best ${fmtScore(best)}`];
	if (exitCode === 1) return ["attempts-exhausted", "no attempts left before start"];
	return ["below-target", `best ${fmtScore(best)} < ${target}, ${after ? after.attemptsMax - (after.attemptsUsed ?? 0) : "?"} attempt(s) left`];
}

async function main() {
	const args = process.argv.slice(2);
	const takeArg = (flag: string) => { const i = args.indexOf(flag); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
	const takeFlag = (flag: string) => { const i = args.indexOf(flag); if (i === -1) return false; args.splice(i, 1); return true; };

	const plan = takeFlag("--plan");
	const refresh = takeFlag("--refresh");
	const retrySolved = takeFlag("--retry-solved");
	const resetMode = takeArg("--reset") ?? "once";
	if (!["once", "each", "none"].includes(resetMode)) usage();
	const only = (takeArg("--only") ?? "").split(",").map(s => s.trim()).filter(Boolean);
	// Flags shared with / passed through to the orchestrator
	takeFlag("--insecure"); // accepted for backwards compatibility; it is the default
	const secure = takeFlag("--secure");
	const noSubmit = takeFlag("--no-submit");
	const model = takeArg("--model");
	const targetArg = takeArg("--target");
	const target = targetArg !== undefined ? Number(targetArg) : DEFAULT_TARGET;
	const solverTimeout = takeArg("--solver-timeout");
	const maxAttemptsArg = takeArg("--max-attempts");
	const maxAttempts = maxAttemptsArg !== undefined ? Number(maxAttemptsArg) : 3;
	if (args.length || !Number.isFinite(target) || !Number.isFinite(maxAttempts)) usage();

	if (secure) process.env.LAB_INSECURE_TLS = "0";
	else if (!process.env.LAB_INSECURE_TLS) process.env.LAB_INSECURE_TLS = "1";
	const insecure = /^(1|true|yes|on)$/i.test(process.env.LAB_INSECURE_TLS.trim());
	const missing = ["LAB_USER", "LAB_PASS"].filter(k => !process.env[k]);
	if (missing.length) { console.error(`Missing required environment variables: ${missing.join(", ")}`); process.exit(1); }

	const passthrough: string[] = [];
	if (secure) passthrough.push("--secure");
	if (noSubmit) passthrough.push("--no-submit");
	if (model) passthrough.push("--model", model);
	passthrough.push("--target", String(target));
	if (solverTimeout) passthrough.push("--solver-timeout", solverTimeout);
	passthrough.push("--max-attempts", String(maxAttempts));

	// 1. Fetch
	if (refresh || !existsSync(INDEX_PATH)) {
		const fetchArgs = secure ? ["--secure"] : [];
		if (refresh) fetchArgs.push("--refresh");
		if (!runPython(FETCH_SCRIPT, fetchArgs, "fetching units")) process.exit(1);
	} else {
		console.log(`[units] using existing ${INDEX_PATH.replace(PROJECT_ROOT + "/", "")} (pass --refresh to re-fetch)`);
	}
	const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as Record<string, string>;
	const taskIds = Object.keys(index).filter(id => !only.length || only.includes(id));
	if (!taskIds.length) { console.error("[units] no tasks to run"); process.exit(1); }

	// 2. Status check → plan
	console.log(`\n[units] checking ${taskIds.length} task(s) on the lab...`);
	const client = new SimpleClient(insecure);
	const results: TaskResult[] = [];
	const toRun: string[] = [];
	for (const id of taskIds) {
		const url = index[id];
		let status: TaskStatus | null = null;
		let reason = "";
		try {
			status = await fetchTaskStatus(url, insecure, client);
			if (status.exhausted) reason = `all ${status.attemptsMax} attempts used (best ${fmtScore(status.bestScore)})`;
			else if (status.closed) reason = `not open (start ${fmtDate(status.startDate)}, deadline ${fmtDate(status.deadline)})`;
			else if (!retrySolved && status.bestScore !== null && status.bestScore >= target) reason = `already solved: best ${fmtScore(status.bestScore)} >= ${target}`;
		} catch (err) {
			reason = `status check failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		const r: TaskResult = { id, url, title: status?.title ?? id, outcome: "skipped", reason, before: status, after: status, exitCode: null, minutes: 0, log: null };
		results.push(r);
		if (!reason) toRun.push(id);
		const s = status;
		console.log(`  ${pad(id, 11)} ${pad(s?.title ?? "?", 44)} attempts ${s ? `${s.attemptsUsed ?? "?"}/${s.attemptsMax}` : "?"}  best ${fmtScore(s?.bestScore)}  ${reason ? "SKIP: " + reason : "RUN"}`);
	}
	console.log(`\n[units] ${toRun.length} task(s) to run: ${toRun.join(", ") || "(none)"}`);
	if (plan || !toRun.length) {
		for (const r of results) if (!r.reason) r.reason = "would run (plan mode)";
		printTable(results, target); process.exit(0);
	}

	// 3. Reset
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const logDir = join(PROJECT_ROOT, "logs", "solve-units", stamp);
	mkdirSync(logDir, { recursive: true });
	if (resetMode === "once" && !runPython(RESET_SCRIPT, [], "resetting all task state")) process.exit(1);

	// 4. Run, one task at a time
	for (const id of toRun) {
		const r = results.find(x => x.id === id)!;
		if (resetMode === "each" && !runPython(RESET_SCRIPT, [id], `resetting ${id}`)) { r.outcome = "fatal"; r.reason = "reset failed"; continue; }
		const logPath = join(logDir, `${id}.log`);
		r.log = logPath.replace(PROJECT_ROOT + "/", "");
		console.log(`\n${"=".repeat(100)}\n[units] ${id} — ${r.title}\n[units] log: ${r.log}\n${"=".repeat(100)}`);
		const t0 = Date.now();
		r.exitCode = await runOrchestrator(id, passthrough, logPath);
		r.minutes = Math.round((Date.now() - t0) / 6000) / 10;
		try { r.after = await fetchTaskStatus(r.url, insecure, client); } catch { /* keep before */ }
		[r.outcome, r.reason] = classify(r.before, r.after, r.exitCode, target, noSubmit, maxAttempts);
		console.log(`\n[units] ${id} finished in ${r.minutes} min: ${r.outcome} — ${r.reason}`);
		writeFileSync(join(logDir, "summary.json"), JSON.stringify({ stamp, target, noSubmit, results }, null, 2));
	}

	// 5. Report
	printTable(results, target);
	console.log(`[units] logs + summary.json in ${logDir.replace(PROJECT_ROOT + "/", "")}/`);
}

function printTable(results: TaskResult[], target: number) {
	console.log(`\n[units] Results (target ${target}):\n`);
	console.log(`  ${pad("task", 11)} ${pad("outcome", 19)} ${pad("attempts", 9)} ${pad("best", 7)} ${pad("min", 6)} reason`);
	console.log("  " + "-".repeat(110));
	for (const r of results) {
		const a = r.after;
		console.log(`  ${pad(r.id, 11)} ${pad(r.outcome, 19)} ${pad(a ? `${a.attemptsUsed ?? "?"}/${a.attemptsMax}` : "?", 9)} ${pad(fmtScore(a?.bestScore), 7)} ${pad(r.minutes ? String(r.minutes) : "-", 6)} ${r.reason}`);
	}
	console.log();
}

main().catch((err) => { console.error("[units] Fatal error:", err); process.exit(99); });
