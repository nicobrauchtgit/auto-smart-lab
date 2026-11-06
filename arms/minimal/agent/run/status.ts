/**
 * Live status files for monitoring a running agent (locally or on a remote VM).
 *
 *   logs/status/run.json   written by solve_units.ts  (batch: task list, current task, outcomes)
 *   logs/status/task.json  written by orchestrate.ts + session_runner.ts (same process):
 *                          phase, iteration, attempts, current LLM session, last tool, heartbeat
 *
 * Two files because solve_units and the orchestrator are different processes; each file has a
 * single writer, so no locking is needed. Writes are atomic (tmp + rename) and best-effort: a
 * failing status write must never break a run. `npm run status` reads both (status_cli.ts).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
export const STATUS_DIR = join(PROJECT_ROOT, "logs", "status");
export const RUN_STATUS = join(STATUS_DIR, "run.json");
export const TASK_STATUS = join(STATUS_DIR, "task.json");

export function readJson<T = Record<string, unknown>>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

const cache = new Map<string, Record<string, unknown>>();

/** Merge `patch` into the status file (shallow merge, nested objects replaced) and stamp updatedAt. */
export function writeStatus(path: string, patch: Record<string, unknown>, opts: { reset?: boolean } = {}): void {
	try {
		const base = opts.reset ? {} : (cache.get(path) ?? readJson(path) ?? {});
		const next = { ...base, ...patch, pid: process.pid, updatedAt: new Date().toISOString() };
		cache.set(path, next);
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
		renameSync(tmp, path);
	} catch {
		/* monitoring must never break a run */
	}
}

/** Convenience for the per-task file. */
export function taskStatus(patch: Record<string, unknown>, opts: { reset?: boolean } = {}): void {
	writeStatus(TASK_STATUS, patch, opts);
}

/** Append a line to the recent-events ring kept in task.json (last 15). */
export function taskEvent(text: string): void {
	const cur = cache.get(TASK_STATUS) ?? readJson(TASK_STATUS) ?? {};
	const events = Array.isArray(cur.events) ? (cur.events as string[]) : [];
	events.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
	taskStatus({ events: events.slice(-15) });
}
