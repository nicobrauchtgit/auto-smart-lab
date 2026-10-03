/**
 * The conditions a run was made under, recorded with every result so runs stay comparable after the
 * harness changes: code version, prompt versions, model, host, Python runtime and every cap.
 *
 * Written to logs/status/task.json (`conditions`), the task log, the batch summary.json and Langfuse
 * metadata. `npm run report` groups results by these fields.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectPythonRuntime } from "./runtime_env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const INSTRUCTIONS_DIR = join(PROJECT_ROOT, "agent", "instructions");

export interface RunConditions {
	recordedAt: string;
	git: { commit: string | null; branch: string | null; dirty: string[] };
	/** sha256 (first 12 hex) of each file in agent/instructions/. */
	prompts: Record<string, string>;
	model: string | null;
	host: string;
	node: string;
	pi: string | null;
	python: { executable: string; version: string; packages: number; virtualenv: boolean } | null;
	/** Flags that change behaviour: target, attempt/cost/time caps, eval mode, ... */
	caps: Record<string, string | number | boolean | null>;
}

function git(args: string[], trim = true): string | null {
	const r = spawnSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8", timeout: 10_000 });
	return r.status === 0 ? (trim ? r.stdout.trim() : r.stdout) : null;
}

function sha12(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

export function collectConditions(caps: RunConditions["caps"]): RunConditions {
	const prompts: Record<string, string> = {};
	for (const f of ["solver.md", "eval.md"]) {
		const p = join(INSTRUCTIONS_DIR, f);
		if (existsSync(p)) prompts[f] = sha12(p);
	}
	// Tracked files with uncommitted changes: a dirty harness is a different harness.
	// Porcelain lines are "XY path": keep the leading status column (no trim before slicing).
	const dirty = (git(["status", "--porcelain", "--untracked-files=no"], false) ?? "")
		.split("\n").filter(l => l.length > 3).map(l => l.slice(3));
	let pi: string | null = null;
	try {
		pi = JSON.parse(readFileSync(join(PROJECT_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version ?? null;
	} catch { /* not installed */ }
	const py = detectPythonRuntime();
	return {
		recordedAt: new Date().toISOString(),
		git: { commit: git(["rev-parse", "--short=10", "HEAD"]), branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), dirty },
		prompts,
		model: process.env.PI_MODEL ?? null,
		host: hostname(),
		node: process.version,
		pi,
		python: py ? { executable: py.executable, version: py.version, packages: py.packages.length, virtualenv: py.inVirtualenv } : null,
		caps,
	};
}

/** One line for the console / task log. */
export function describeConditions(c: RunConditions): string {
	const caps = Object.entries(c.caps).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(" ");
	const prompts = Object.entries(c.prompts).map(([k, v]) => `${k.replace(/\.md$/, "")}@${v}`).join(" ");
	return `commit ${c.git.commit ?? "?"}${c.git.dirty.length ? ` (+${c.git.dirty.length} uncommitted: ${c.git.dirty.slice(0, 5).join(", ")})` : ""}; prompts ${prompts}; ` +
		`model ${c.model ?? "default"}; host ${c.host}; node ${c.node}; pi ${c.pi ?? "?"}; ` +
		`python ${c.python ? `${c.python.version}${c.python.virtualenv ? " venv" : ""} ${c.python.packages} pkgs` : "none"}; ${caps}`;
}
