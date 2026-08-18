/**
 * Thin wrapper around agent/memory/memory.json for use by the orchestrator.
 * Not exposed as a pi tool — used directly by TypeScript runner code.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, ".."); // agent/run/ → agent/
const MEMORY_FILE = join(PROJECT_ROOT, "memory", "memory.json");

export interface TaskMemory {
	best_score: number | null;
	best_approach: string;
	last_val_score: number | null;
	last_submission_csv: string;
	tries_used: number;
	tries_left: number;
	failed_approaches: string[];
	eval_decision: string | null;
	eval_notes: string;
}

export interface MemoryStore {
	tasks: Record<string, TaskMemory>;
	sessions: unknown[];
	global_notes: string;
}

export function readMemory(): MemoryStore {
	if (!existsSync(MEMORY_FILE)) {
		return { tasks: {}, sessions: [], global_notes: "" };
	}
	try {
		return JSON.parse(readFileSync(MEMORY_FILE, "utf8")) as MemoryStore;
	} catch {
		return { tasks: {}, sessions: [], global_notes: "" };
	}
}

export function getTaskMemory(taskId: string): TaskMemory {
	const store = readMemory();
	const saved = store.tasks[taskId] ?? {};
	return {
		best_score: (saved as TaskMemory).best_score ?? null,
		best_approach: (saved as TaskMemory).best_approach ?? "",
		last_val_score: (saved as TaskMemory).last_val_score ?? null,
		last_submission_csv: (saved as TaskMemory).last_submission_csv ?? "",
		tries_used: (saved as TaskMemory).tries_used ?? 0,
		tries_left: (saved as TaskMemory).tries_left ?? 3,
		failed_approaches: (saved as TaskMemory).failed_approaches ?? [],
		eval_decision: (saved as TaskMemory).eval_decision ?? null,
		eval_notes: (saved as TaskMemory).eval_notes ?? "",
	};
}
