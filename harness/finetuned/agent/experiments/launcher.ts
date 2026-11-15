/**
 * The launcher every supervised command runs under on Linux: a child subreaper.
 *
 * Without it a process the command leaves behind (`setsid cmd &`, a daemon's
 * double fork) re-parents to init once its parent exits, and is found only if a
 * sample saw it while its parent link still led to the run. A command that
 * exits before the first sample loses such a worker for good. Under the reaper
 * (`reaper.py`, `prctl(PR_SET_CHILD_SUBREAPER)`) every orphan re-parents to the
 * reaper instead, so at any moment every process of the run is a descendant of
 * the launcher and one scan finds it, whenever that scan happens. It works
 * unprivileged; a per-call cgroup would need a delegated cgroup subtree.
 *
 * The reaper also records the command's own PID and exit in a status file, so
 * a shell call can return when its shell ends while processes it left keep
 * being tracked. Darwin has no subreaper; there the process group is followed.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARM_ROOT } from "../paths.js";
import { readRecordJson } from "./safe_files.js";

export const REAPER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "reaper.py");
/** Name of the status file in each experiment directory. */
export const COMMAND_STATUS_FILE = "command.json";

/** The project Python (`./dev setup`), standard library only, isolated and without site. */
export function reaperPython(): string {
	return join(resolve(ARM_ROOT, process.env.VENV_DIR ?? ".venv"), "bin/python");
}

/** Whether supervised commands run under the subreaper on this platform. */
export const usesReaper = (): boolean => process.platform === "linux";

export function reaperArgv(statusPath: string, argv: readonly string[], python = reaperPython()): string[] {
	return [python, "-I", "-S", REAPER_SCRIPT, statusPath, "--", ...argv];
}

/** What is spawned for `argv`: the reaper with the command after it, or the command itself where there is no reaper. */
export function launchArgv(statusPath: string, argv: readonly string[]): { argv: string[]; launcher: boolean } {
	return usesReaper() ? { argv: reaperArgv(statusPath, argv), launcher: true } : { argv: [...argv], launcher: false };
}

/** What the reaper recorded about the command: its PID, and its exit once it ended. */
export interface CommandStatus { pid: number; exitCode?: number; signal?: string }

/** The status file, validated; undefined while absent, partial, malformed or a symlink (never followed). */
export function readCommandStatus(path: string): CommandStatus | undefined {
	const value = readRecordJson(path);
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { pid, exitCode, signal } = value as Record<string, unknown>;
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
	return { pid: pid as number,
		...(Number.isSafeInteger(exitCode) ? { exitCode: exitCode as number } : {}),
		...(typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal) ? { signal } : {}) };
}

export const commandEnded = (status: CommandStatus | undefined): boolean =>
	status !== undefined && (status.exitCode !== undefined || status.signal !== undefined);

/**
 * Preflight: the launcher starts, becomes a subreaper and reports a command's
 * exit. Bounded (5 s), runs `true`, writes only a temporary directory.
 */
export function checkReaper(python = reaperPython()): void {
	if (!usesReaper()) return;
	try { accessSync(python, constants.X_OK); }
	catch { throw new Error(`The supervision launcher needs the project Python at ${python}; run ./dev setup`); }
	if (!existsSync(REAPER_SCRIPT)) throw new Error(`Supervision launcher script missing: ${REAPER_SCRIPT}`);
	const directory = mkdtempSync(join(tmpdir(), "reaper-check-"));
	try {
		const status = join(directory, COMMAND_STATUS_FILE);
		const result = spawnSync(python, reaperArgv(status, ["true"], python).slice(1), { timeout: 5_000, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
		const recorded = readCommandStatus(status);
		if (result.error || result.status !== 0 || recorded?.exitCode !== 0) {
			// The launcher's own message only (no environment, no credentials).
			throw new Error(`The supervision launcher (child subreaper) does not work here: ${(result.stderr ?? "").trim().slice(0, 300) || result.error?.message || `exit ${result.status}`}`);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
