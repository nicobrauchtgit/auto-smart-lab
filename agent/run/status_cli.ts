#!/usr/bin/env npx tsx
/**
 * Show what a running (or the last) agent run is doing.
 *
 *   npm run status                 one-shot summary
 *   npm run status -- --watch      refresh every 10 s (Ctrl-C to stop)
 *   npm run status -- --json       raw status files, for scripts / remote monitoring
 *   npm run status -- --lines 40   more lines from the live task log (default 15)
 *
 * Reads logs/status/{run,task}.json written by solve_units.ts, orchestrate.ts and
 * session_runner.ts. Works the same on the VM and locally; over SSH use scripts/vm/remote.sh.
 */

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, readJson, RUN_STATUS, TASK_STATUS } from "./status.js";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const asJson = args.includes("--json");
const li = args.indexOf("--lines");
const tailLines = li >= 0 ? Number(args[li + 1]) || 15 : 15;

function alive(pid: unknown): boolean {
	if (typeof pid !== "number") return false;
	try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
function ago(iso?: string | null): string {
	if (!iso) return "-";
	const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
	if (s < 0) return `in ${fmtDur(-s)}`;
	return `${fmtDur(s)} ago`;
}
function fmtDur(s: number): string {
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function since(iso?: string | null): string {
	return iso ? fmtDur(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))) : "-";
}
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s.padEnd(n); }
function tail(path: string, n: number): string[] {
	try {
		const lines = readFileSync(path, "utf8").split("\n").filter(l => l && !l.includes("⏳ still running"));
		return lines.slice(-n);
	} catch { return []; }
}

function render(): string {
	const run = readJson<Json>(RUN_STATUS);
	const rawTask = readJson<Json>(TASK_STATUS);
	// Standalone sessions (probes) write session/usage fields without an orchestrator task: ignore those.
	const task = rawTask && rawTask.task ? rawTask : null;
	if (asJson) return JSON.stringify({ run, task, now: new Date().toISOString() }, null, 2);
	const out: string[] = [];
	const now = new Date().toISOString().replace("T", " ").slice(0, 19);
	out.push(`auto-smart-lab status — ${now} (${hostname()})`);

	if (!run && !task) {
		out.push("", "No status files yet (logs/status/). Nothing has run since monitoring was added.");
		return out.join("\n");
	}

	// ---- Batch ----
	if (run) {
		const runAlive = alive(run.pid);
		const state = run.state === "running" && !runAlive ? "DEAD (process gone without finishing)" : run.state;
		out.push("", `BATCH   ${state}   started ${ago(run.startedAt)}   model ${run.model ?? "default"}   target ${run.target}${run.noSubmit ? "   --no-submit" : ""}`);
		out.push(`        logs: ${run.logDir}${run.spentUsd ? `   spent $${Number(run.spentUsd).toFixed(2)}${run.maxCostUsd ? ` of $${run.maxCostUsd}` : ""}` : run.maxCostUsd ? `   budget $${run.maxCostUsd}` : ""}`);
		const tasks: Json[] = run.tasks ?? [];
		if (tasks.length) {
			out.push("", `  ${pad("task", 11)} ${pad("status", 19)} ${pad("attempts", 9)} ${pad("best", 7)} ${pad("min", 6)} note`);
			for (const t of tasks) {
				const status = t.id === run.current ? "▶ RUNNING" : !t.run ? "skipped" : t.outcome === "skipped" ? "queued" : t.outcome;
				const note = t.id === run.current ? `for ${since(run.currentStartedAt)}` : t.reason ?? "";
				out.push(`  ${pad(t.id, 11)} ${pad(status, 19)} ${pad(String(t.attempts), 9)} ${pad(t.best == null ? "-" : Number(t.best).toFixed(4), 7)} ${pad(t.minutes ? String(t.minutes) : "-", 6)} ${String(note).slice(0, 70)}`);
			}
		}
	}

	// ---- Current task ----
	if (task) {
		const taskAlive = alive(task.pid);
		const hb = task.heartbeatAt ? Math.round((Date.now() - Date.parse(task.heartbeatAt)) / 1000) : null;
		let health = task.phase === "exited" ? `exited (code ${task.exitCode}) ${ago(task.endedAt)}` : taskAlive ? "alive" : "DEAD (process gone)";
		if (taskAlive && task.phase !== "exited" && hb !== null && hb > 120 && task.session?.state !== "rate-limited") health += `  ⚠ no heartbeat for ${fmtDur(hb)}`;
		out.push("", `TASK    ${task.task}   phase ${task.phase}   iteration ${task.iteration ?? "-"}   ${health}`);
		if (task.python) out.push(`        python ${task.python.version}${task.python.virtualenv ? " (venv)" : ""}, ${task.python.packages} packages — ${task.python.executable}`);
		out.push(`        started ${ago(task.startedAt)}${task.localScore != null ? `   local ${task.localScore}` : ""}${task.result ? `   platform ${task.result.platformScore} (${task.result.triesLeft} left)` : ""}`);
		const s = task.session;
		if (s && task.phase !== "exited") {
			const cap = s.capMinutes ? ` of ${s.capMinutes}m cap` : "";
			let state = s.state;
			if (String(s.state).startsWith("running") && s.currentToolSince) state += ` for ${since(s.currentToolSince)}`;
			if (s.state === "rate-limited" && s.rateLimitedUntil) state += ` until ${String(s.rateLimitedUntil).slice(11, 19)} (${ago(s.rateLimitedUntil)})`;
			out.push("", `SESSION ${s.label}   ${since(s.startedAt)}${cap}   ${s.toolCalls} tool calls   ${state}`);
			if (s.lastCall) out.push(`        last call:   ${String(s.lastCall).slice(0, 140)}`);
			if (s.lastResult) out.push(`        last result: ${String(s.lastResult).slice(0, 140)}`);
			if (s.lastText) out.push(`        last said:   ${String(s.lastText).replace(/\s+/g, " ").slice(0, 140)}`);
		}
		const u = task.usage;
		if (u && u.requests) out.push("", `USAGE   ${u.requests} model calls   ${(u.input / 1e6).toFixed(2)}M in / ${(u.output / 1e3).toFixed(0)}k out tokens   cost $${Number(u.costUsd).toFixed(3)}${u.budgetUsd ? ` of $${u.budgetUsd}` : ""}`);
		const q = task.apiQuota;
		if (q) out.push("", `API     remaining: ${q.minute ?? "?"}/min  ${q.hour ?? "?"}/hour  ${q.day ?? "?"}/day  ${q.month ?? "?"}/month   (last HTTP ${q.status}, ${ago(q.at)})`);
		const ev: string[] = task.events ?? [];
		if (ev.length) { out.push("", "EVENTS"); for (const e of ev.slice(-8)) out.push(`  ${e}`); }
	}

	// ---- Live log tail ----
	const logRel = run?.current ? run.currentLog : null;
	const logPath = logRel ? join(PROJECT_ROOT, logRel) : null;
	if (logPath && existsSync(logPath) && tailLines > 0) {
		out.push("", `LOG     ${logRel} (last ${tailLines}, heartbeats hidden)`);
		for (const l of tail(logPath, tailLines)) out.push(`  ${l.slice(0, 180)}`);
	}
	return out.join("\n");
}

if (watch) {
	const draw = () => { process.stdout.write("\x1b[2J\x1b[H" + render() + "\n\n(refreshing every 10 s — Ctrl-C to stop)\n"); };
	draw();
	setInterval(draw, 10_000);
} else {
	console.log(render());
}
