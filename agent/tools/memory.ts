/**
 * Persistent memory tools for the SmartLab ML agent.
 *
 * Exposes three pi tools:
 *   memory_read            – read the full memory store
 *   memory_write           – deep-merge a patch into the store (atomic write)
 *   memory_append_session  – append a session log entry
 *
 * State file: <project-root>/agent/memory/memory.json
 * The file is gitignored; the directory is tracked via .gitkeep.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, ".."); // <root>/agent/tools/memory.ts → <root>/agent
const MEMORY_DIR = join(PROJECT_ROOT, "memory");
const MEMORY_FILE = join(MEMORY_DIR, "memory.json");

// --------------------------------------------------------------------------
// Default memory schema
// --------------------------------------------------------------------------

interface TaskMemory {
	best_score: number | null;
	best_approach: string;
	last_val_score: number | null;
	last_submission_csv: string;
	tries_used: number;
	tries_left: number;
	failed_approaches: string[];
	eval_decision: string | null;
	eval_notes: string;
	checkpoint?: Record<string, unknown>;
}

interface SessionEntry {
	timestamp: string;
	task_id: string;
	phase: "solve" | "eval";
	approach: string;
	val_score: number | null;
	notes: string;
}

interface MemoryStore {
	tasks: Record<string, TaskMemory>;
	sessions: SessionEntry[];
	global_notes: string;
}

function defaultStore(): MemoryStore {
	return { tasks: {}, sessions: [], global_notes: "" };
}

// --------------------------------------------------------------------------
// Read / write helpers
// --------------------------------------------------------------------------

function readStore(): MemoryStore {
	if (!existsSync(MEMORY_FILE)) return defaultStore();
	try {
		return JSON.parse(readFileSync(MEMORY_FILE, "utf8")) as MemoryStore;
	} catch {
		return defaultStore();
	}
}

function writeStore(store: MemoryStore): void {
	if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
	const tmp = `${MEMORY_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, MEMORY_FILE);
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof target[key] === "object" &&
			target[key] !== null &&
			!Array.isArray(target[key])
		) {
			out[key] = deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "memory_read",
			label: "Memory: read",
			description: "Read the full persistent memory store for this project. Returns task histories, session logs, and global notes.",
			promptSnippet: "Read the agent memory store",
			promptGuidelines: [
				"Call memory_read at the start of every session to review past scores, failed approaches, and global notes before starting work.",
			],
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal) {
				const store = readStore();
				return {
					content: [{ type: "text", text: JSON.stringify(store, null, 2) }],
					details: store as unknown as Record<string, unknown>,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "memory_write",
			label: "Memory: write",
			description:
				"Deep-merge a patch object into the persistent memory store. Use this to record scores, approaches, failed strategies, and submission results.",
			promptSnippet: "Write to the agent memory store",
			promptGuidelines: [
				"After completing validation or solving, call memory_write to record last_val_score, last_submission_csv, approach used, and any failed_approaches.",
				"To update a nested key such as tasks.spam1.last_val_score, pass { tasks: { spam1: { last_val_score: 0.99 } } }.",
			],
			parameters: Type.Object({
				patch: Type.Record(
					Type.String(),
					Type.Unknown(),
					{ description: "Partial memory object to deep-merge into the store" },
				),
			}),
			async execute(_toolCallId, params, _signal) {
				const store = readStore();
				const merged = deepMerge(store as unknown as Record<string, unknown>, params.patch as Record<string, unknown>);
				writeStore(merged as unknown as MemoryStore);
				return {
					content: [{ type: "text", text: "Memory updated." }],
					details: {},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "memory_append_session",
			label: "Memory: append session",
			description: "Append a session log entry to the sessions history array.",
			promptSnippet: "Append a session entry to memory",
			promptGuidelines: [
				"Call memory_append_session at the end of a solve or eval session to log what was done.",
			],
			parameters: Type.Object({
				task_id: Type.String({ description: "Task identifier, e.g. spam1" }),
				phase: Type.Union([Type.Literal("solve"), Type.Literal("eval")], { description: "Session phase" }),
				approach: Type.Optional(Type.String({ description: "Brief description of the approach used" })),
				val_score: Type.Optional(Type.Number({ description: "Local validation balanced accuracy" })),
				notes: Type.Optional(Type.String({ description: "Any additional notes or observations" })),
			}),
			async execute(_toolCallId, params, _signal) {
				const store = readStore();
				const entry: SessionEntry = {
					timestamp: new Date().toISOString(),
					task_id: params.task_id,
					phase: params.phase,
					approach: params.approach ?? "",
					val_score: params.val_score ?? null,
					notes: params.notes ?? "",
				};
				store.sessions.push(entry);
				writeStore(store);
				return {
					content: [{ type: "text", text: `Session entry appended for task ${params.task_id} (${params.phase}).` }],
					details: entry as unknown as Record<string, unknown>,
				};
			},
		}),
	);
}
