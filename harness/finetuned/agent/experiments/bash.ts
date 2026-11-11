import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ExperimentSupervisor, type SupervisorOptions } from "./supervisor.js";

/** Comparable shell calls needed before one can be called slow. */
export const SHELL_HISTORY_MIN = 3;
const SHELL_HISTORY_KEEP = 20;

/**
 * Durations of completed shell calls, per working directory and command.
 *
 * Like is compared with like: only the same command (whitespace-normalised) in
 * the same directory counts as a comparable call. Projecting a training script
 * from the median of `ls` and `true` calls is what made almost every
 * non-trivial call look time-wasting.
 */
const durations = new Map<string, number[]>();

export function shellCommandKey(cwd: string, command: string): string {
	return `${cwd}\0${command.trim().replace(/\s+/g, " ")}`;
}

/** Median duration of earlier runs of this exact command, once there are enough of them. */
export function shellProjection(key: string): number | undefined {
	const history = durations.get(key) ?? [];
	if (history.length < SHELL_HISTORY_MIN) return undefined;
	return [...history].sort((a, b) => a - b)[Math.floor(history.length / 2)];
}

export function recordShellDuration(key: string, ms: number): void {
	durations.set(key, [...(durations.get(key) ?? []), ms].slice(-SHELL_HISTORY_KEEP));
}

export interface SupervisedBashOptions extends SupervisorOptions {
	/**
	 * The process supervised for one command. Defaults to `bash -c <command>`; a
	 * sandboxed session passes its sandbox launcher, so the supervised process is
	 * the sandboxed one and the boundary holds.
	 */
	argv?: (command: string) => string[];
}

/** Blocking shell tool, with the same sampler/arbiter as harness trials.
 * Callers supply the owning session's delivery and reporter callbacks.
 * root must be writable and visible to that session's read tool.
 *
 * The tool result is the answer: the end of the output (within the cap), the
 * exit code and the path of the full output. Only findings while the call runs
 * (stuck, stale, flooding, time-wasting, runaway memory, machine protection)
 * are delivered on top of it.
 */
export function createSupervisedBashTool(cwd: string, options: SupervisedBashOptions) {
	const definition = createBashToolDefinition(cwd);
	return { ...definition,
		async execute(id: string, args: { command: string; timeout?: number }, signal?: AbortSignal) {
			signal?.throwIfAborted();
			mkdirSync(options.root, { recursive: true });
			const key = shellCommandKey(cwd, args.command);
			const root = mkdtempSync(join(options.root, "bash-"));
			const supervisor = new ExperimentSupervisor({ ...options, root, blocking: true });
			const view = supervisor.start({ argv: options.argv?.(args.command) ?? ["bash", "-c", args.command], cwd,
				hypothesis: "agent shell call", scope: "shell", projectedDurationMs: shellProjection(key) }, id);
			const abort = () => { void supervisor.stop(view.id, "owning session cancelled"); };
			signal?.addEventListener("abort", abort, { once: true });
			try {
				while (supervisor.status(view.id).status === "running") {
					signal?.throwIfAborted();
					await new Promise(resolve => setTimeout(resolve, supervisor.limits.sampleIntervalMs));
				}
				const final = supervisor.status(view.id);
				if (final.status === "exited") recordShellDuration(key, final.elapsedSeconds * 1000);
				const prompts = supervisor.notes;
				const ending = [
					...(final.stopReason ? [prompts.render("experiments.shell-stopped", { reason: final.stopReason }).text] : []),
					prompts.render("experiments.shell-result", { exitCode: String(final.exitCode ?? final.status), logPath: final.logPath }).text,
				].join("\n");
				const cap = supervisor.limits.outputCapBytes;
				// Sized for the largest possible omission, so the whole response fits the cap.
				const notice = (omitted: number) => prompts.render("experiments.shell-truncated", { omittedBytes: String(omitted), logPath: final.logPath }).text;
				const reserve = Buffer.byteLength(`${notice(Number.MAX_SAFE_INTEGER)}\n\n${ending}`);
				// The end of the output is kept: that is where a traceback or a result is.
				const tail = supervisor.tail(view.id, Math.max(0, cap - reserve));
				const text = `${tail.omittedBytes > 0 ? `${notice(tail.omittedBytes)}\n` : ""}${tail.text}${tail.text.endsWith("\n") || !tail.text ? "" : "\n"}${ending}`;
				return { content: [{ type: "text" as const, text }],
					details: { ...final, spillPath: final.logPath, omittedBytes: tail.omittedBytes } };
			} finally {
				signal?.removeEventListener("abort", abort);
				await supervisor.close();
			}
		},
	};
}
