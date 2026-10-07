/** Environment boundary for harness-owned training processes. */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const RUNTIME_KEYS = [
	"PATH",
	"VENV_DIR",
	"VIRTUAL_ENV",
	"UV_PROJECT_ENVIRONMENT",
	"UV_PYTHON",
	"UV_PYTHON_DOWNLOADS",
	"PYTHONNOUSERSITE",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_COLLATE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LD_LIBRARY_PATH",
] as const;

export interface TrainingEnvironmentIdentity {
	pipelineRunId?: string;
	stageInvocationId?: string;
}

/**
 * Locate the native libraries binary Python wheels expect on Nix hosts
 * (`libstdc++` and `libz`), and return an LD_LIBRARY_PATH that provides them.
 */
export function resolveCppRuntimeLibraryPath(
	source: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	// An unrelated LD_LIBRARY_PATH, such as one inherited from a desktop app, is
	// not evidence that the libraries are reachable; check for each library itself.
	const existing = (source.LD_LIBRARY_PATH ?? "").split(delimiter).filter(Boolean);
	const added: string[] = [];
	for (const library of RUNTIME_LIBRARIES) {
		if ([...added, ...existing].some((directory) => existsSync(join(directory, library)))) continue;
		const directory = devboxLibraryDirectory(source, library)
			?? (library === CPP_RUNTIME ? compilerRuntimeDirectory() : undefined);
		if (directory) added.push(directory);
	}
	if (added.length === 0) return source.LD_LIBRARY_PATH || undefined;
	return [...added, ...existing].join(delimiter);
}

const CPP_RUNTIME = "libstdc++.so.6";
const RUNTIME_LIBRARIES = [CPP_RUNTIME, "libz.so.1"] as const;

/**
 * The store directory of a library Devbox installs (`stdenv.cc.cc.lib`, `zlib`).
 * Only that directory is returned, not the whole profile `lib/`, so other Nix
 * binaries keep resolving their own libraries.
 */
function devboxLibraryDirectory(source: Readonly<Record<string, string | undefined>>, library: string): string | undefined {
	if (!source.DEVBOX_PACKAGES_DIR) return undefined;
	const link = join(source.DEVBOX_PACKAGES_DIR, "lib", library);
	return existsSync(link) ? dirname(realpathSync(link)) : undefined;
}

function compilerRuntimeDirectory(): string | undefined {
	const result = spawnSync("g++", [`-print-file-name=${CPP_RUNTIME}`], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (result.status !== 0) return undefined;
	const library = result.stdout.trim();
	return isAbsolute(library) && existsSync(library) ? dirname(library) : undefined;
}

/**
 * Build the complete environment handed to a training supervisor.
 *
 * This is intentionally an allowlist. Training code needs the selected Python
 * runtime and basic process facilities, but it must not inherit credentials or
 * unrelated variables from the solve session. Pipeline identity comes from the
 * harness' typed options instead of caller-controlled environment entries.
 * `PYTHONUNBUFFERED` is omitted because ExperimentSupervisor owns that setting.
 */
export function sanitizeTrainingEnvironment(
	source: Readonly<Record<string, string | undefined>>,
	identity: TrainingEnvironmentIdentity = {},
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of RUNTIME_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	if (identity.pipelineRunId) environment.PIPELINE_RUN_ID = identity.pipelineRunId;
	if (identity.stageInvocationId) environment.PIPELINE_STAGE_INVOCATION_ID = identity.stageInvocationId;
	return environment;
}
