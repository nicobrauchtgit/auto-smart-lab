import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptSnapshot } from "../prompts/loader.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = join(ROOT, "agent/runtime/python");
const MANAGER = join(ROOT, "agent/setup/python_environment.py");
const CHANGES = join(STATE, "changes.jsonl");

export interface PythonEnvironment {
	schema_version: 1;
	python_version: string;
	executable: string;
	prefix: string;
	packages: Array<{ name: string; version: string }>;
	declared_dependencies: string[];
	project_sha256: string;
	lock_sha256: string | null;
	healthy: boolean;
	/** uv.lock still agrees with pyproject.toml. */
	lock_current: boolean;
	/** The installed environment still matches uv.lock. */
	environment_matches_lock: boolean;
	dependency_errors: string;
	fingerprint: string;
}

export function readPythonEnvironment(requireHealthy = true): PythonEnvironment {
	const environment = resolve(ROOT, process.env.VENV_DIR ?? ".venv");
	const python = join(environment, "bin/python");
	if (!existsSync(python)) throw new Error("Devbox Python is not ready; run devbox run python-setup");
	const result = spawnSync(python, ["-I", MANAGER, "inspect", "--json"], {
		cwd: ROOT, encoding: "utf8", timeout: 30_000,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Cannot inspect Devbox Python: ${result.error?.message ?? result.stderr}`);
	}
	return validatePythonEnvironment(JSON.parse(result.stdout), requireHealthy);
}

export function validatePythonEnvironment(value: unknown, requireHealthy = true): PythonEnvironment {
	const data = value as PythonEnvironment;
	const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
	if (!data || data.schema_version !== 1 || typeof data.python_version !== "string"
		|| typeof data.executable !== "string" || typeof data.prefix !== "string"
		|| !hash(data.fingerprint) || !hash(data.project_sha256)
		|| (data.lock_sha256 !== null && !hash(data.lock_sha256))
		|| !Array.isArray(data.packages) || !data.packages.every(p => p && typeof p.name === "string" && typeof p.version === "string")
		|| !Array.isArray(data.declared_dependencies) || !data.declared_dependencies.every(p => typeof p === "string" && p.length > 0)
		|| typeof data.healthy !== "boolean" || typeof data.lock_current !== "boolean"
		|| typeof data.environment_matches_lock !== "boolean" || typeof data.dependency_errors !== "string"
		|| data.healthy !== (data.lock_current && data.environment_matches_lock)
		|| (data.lock_current && data.lock_sha256 === null)) {
		throw new Error("Invalid Python environment inventory");
	}
	if (requireHealthy && !data.healthy) {
		// Say which of the two drifts happened: an out-of-date lockfile and an
		// environment that no longer matches the lock need different fixes.
		const reasons = [
			data.lock_current === false ? "uv.lock does not match pyproject.toml" : "",
			data.environment_matches_lock === false ? "the installed environment does not match uv.lock" : "",
		].filter(Boolean);
		throw new Error(`Devbox Python environment is not ready: ${reasons.join("; ")}. ${data.dependency_errors ?? ""}\nRun devbox run python-setup`);
	}
	return data;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function preparePythonEnvironment(prompts: PromptSnapshot, environment: PythonEnvironment) {
	const lockPath = join(ROOT, "uv.lock");
	const projectPath = join(ROOT, "pyproject.toml");
	const prompt = prompts.render("shared.python-environment", {
		pythonExecutable: environment.executable,
		declaredDependencies: environment.declared_dependencies.join("\n"),
		totalDistributions: String(environment.packages.length),
		environmentHash: environment.fingerprint,
		projectPath,
		lockPath,
		notesPath: join(STATE, "NOTES.md"),
		pythonCommand: shellQuote(environment.executable),
		managerCommand: shellQuote(MANAGER),
	});
	return {
		prompt,
		input: {
			kind: "python_environment", version: 1, delivery: "initial_prompt" as const,
			status: "available" as const, artifact: lockPath,
			content_sha256: environment.fingerprint,
			python_version: environment.python_version, executable: environment.executable,
			packages: environment.packages,
			declared_dependencies: environment.declared_dependencies,
			project_sha256: environment.project_sha256,
			lock_sha256: environment.lock_sha256,
			// Recorded so a trace shows whether the run's environment still agreed
			// with its lockfile, rather than only which packages were present.
			lock_current: environment.lock_current,
			environment_matches_lock: environment.environment_matches_lock,
		},
		env: {
			VENV_DIR: environment.prefix,
			VIRTUAL_ENV: environment.prefix,
			UV_PROJECT_ENVIRONMENT: environment.prefix,
			UV_PYTHON: environment.executable,
			UV_PYTHON_DOWNLOADS: "never",
			PATH: `${join(environment.prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
			PYTHONNOUSERSITE: "1",
		},
	};
}

/** Byte offsets keep earlier runs' records out of this session's trace. */
export function pythonChangeCursor(path = CHANGES): number {
	try { return statSync(path).size; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export function readPythonChanges(cursor: number, path = CHANGES): Record<string, unknown>[] {
	let fd: number;
	try { fd = openSync(path, "r"); }
	catch (error) {
		if (cursor === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const size = fstatSync(fd).size;
		if (size < cursor) throw new Error("Python change history was truncated during the session");
		const bytes = Buffer.alloc(size - cursor);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, cursor + offset);
			if (!count) throw new Error("Python change history changed while reading");
			offset += count;
		}
		return bytes.toString("utf8").split("\n").filter(Boolean).map(line => {
			const event = JSON.parse(line);
			if (!event || event.schema_version !== 1 || typeof event.reason !== "string"
				|| typeof event.action !== "string" || typeof event.outcome !== "string") {
				throw new Error("Invalid Python dependency change record");
			}
			return event;
		});
	} finally { closeSync(fd); }
}

/** Also called from the session's failure and cancellation cleanup. */
export function recordPythonEnvironmentEnd(options: {
	initial: PythonEnvironment;
	cursor: number;
	sessionId: string;
	record: (type: string, payload: Record<string, unknown>) => void;
}, dependencies = { readEnvironment: readPythonEnvironment, readChanges: readPythonChanges }) {
	const { initial, record } = options;
	try {
		// Inspection waits for manager mutations before we read their audit outcomes.
		const final = dependencies.readEnvironment(false);
		record("runtime_environment_end", {
			type: "runtime_environment_end", kind: "python_environment",
			initial_fingerprint: initial.fingerprint, final_fingerprint: final.fingerprint,
			changed: final.fingerprint !== initial.fingerprint,
			project_changed: final.project_sha256 !== initial.project_sha256,
			lock_changed: final.lock_sha256 !== initial.lock_sha256,
			healthy: final.healthy, lock_current: final.lock_current,
			environment_matches_lock: final.environment_matches_lock,
			dependency_errors: final.dependency_errors,
			project_sha256: final.project_sha256, lock_sha256: final.lock_sha256,
			declared_dependencies: final.declared_dependencies, packages: final.packages,
		});
	} catch (error) {
		record("runtime_environment_end", {
			type: "runtime_environment_end", kind: "python_environment", status: "unavailable",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		for (const change of dependencies.readChanges(options.cursor)) {
			record("runtime_dependency_change", {
				type: "runtime_dependency_change", kind: "python_environment",
				requested_by_session: change.session_id === options.sessionId, change,
			});
		}
	} catch (error) {
		record("runtime_dependency_change", {
			type: "runtime_dependency_change", kind: "python_environment", status: "unavailable",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
