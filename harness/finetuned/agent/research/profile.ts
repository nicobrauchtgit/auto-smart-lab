/**
 * Harness data profile for the research workspace.
 *
 * Runs the deterministic profiler over the declared task data before the agent
 * starts and writes `profile/profile.json`. A failed profile never fails the
 * stage: the agent then works without it, and the status says why.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HARNESS_CONFIG } from "../harness/config.js";
import { projectPython, taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { PROJECT_ROOT } from "./context.js";
import { ARM_ROOT } from "../paths.js";

export const DATA_PROFILE_SCRIPT = join(ARM_ROOT, "agent", "research", "python", "data_profile.py");
/** Workspace-relative path the agent reads and cites. */
export const DATA_PROFILE_PATH = "profile/profile.json";

export interface DataProfileStatus {
	status: "available" | "unavailable";
	path?: string;
	sha256?: string;
	records?: number;
	layers?: string[];
	reason?: string;
	duration_ms: number;
}

export interface BuildDataProfileOptions {
	taskId: string;
	configuration?: TaskConfiguration;
	workspace: string;
	datasetSnapshotSha256: string;
	python?: string;
	timeoutMs?: number;
	/** Test seam for the task data location. */
	taskDir?: string;
}

export function buildDataProfile(options: BuildDataProfileOptions): DataProfileStatus {
	const started = Date.now();
	const out = join(options.workspace, DATA_PROFILE_PATH);
	// Never leave a profile from another dataset snapshot behind.
	rmSync(out, { force: true });
	const unavailable = (reason: string): DataProfileStatus => ({ status: "unavailable", reason, duration_ms: Date.now() - started });
	if (!options.configuration) return unavailable("No task configuration declares the training and test data.");
	const paths = taskDataPaths(options.taskId, options.configuration, options.taskDir);
	mkdirSync(join(options.workspace, "profile"), { recursive: true });
	const spec = {
		trainZip: paths.trainZip, testZip: paths.testZip, targetsPath: paths.targetsPath ?? null,
		targets: options.configuration.targets.kind, source: options.configuration.samples.source,
		datasetSnapshotSha256: options.datasetSnapshotSha256,
		textMinFraction: HARNESS_CONFIG.research.profileTextMinPercent / 100,
	};
	const result = spawnSync(options.python ?? projectPython(), ["-I", DATA_PROFILE_SCRIPT, "--spec", JSON.stringify(spec), "--out", out], {
		encoding: "utf8", timeout: options.timeoutMs ?? HARNESS_CONFIG.research.profileTimeoutMs, maxBuffer: 1024 * 1024,
	});
	if (result.error) return unavailable((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "Data profile timed out" : "Data profile could not run");
	let summary: { error?: string; records?: number; layers?: string[] } = {};
	try { summary = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}"); } catch { /* reported below */ }
	if (result.status !== 0 || !existsSync(out)) {
		rmSync(out, { force: true });
		return unavailable(`Data profile failed: ${summary.error ?? `exit ${result.status}`}`);
	}
	return {
		status: "available", path: DATA_PROFILE_PATH,
		sha256: createHash("sha256").update(readFileSync(out)).digest("hex"),
		records: summary.records, layers: summary.layers, duration_ms: Date.now() - started,
	};
}
