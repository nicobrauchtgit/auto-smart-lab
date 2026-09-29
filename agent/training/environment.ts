/** Environment boundary for harness-owned training processes. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

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

/** Locate the C++ runtime required by binary Python wheels on Nix hosts. */
export function resolveCppRuntimeLibraryPath(
	source: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	if (source.LD_LIBRARY_PATH) return source.LD_LIBRARY_PATH;
	const result = spawnSync("g++", ["-print-file-name=libstdc++.so.6"], {
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
