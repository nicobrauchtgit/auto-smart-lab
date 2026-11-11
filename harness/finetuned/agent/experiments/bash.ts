import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
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

/**
 * Shell tool with the same sampler, findings and machine protection as harness trials.
 *
 * A call returns when its own command (the shell) ends, as a shell does. What
 * the command left running stays with the tool's supervisor: sampled, under
 * machine protection, its findings delivered to the owner, and stopped when
 * the tool is closed (the owning session ends). The result says how many are
 * still running, their PIDs and how to stop them. `timeout` (seconds) stops
 * the call's whole process tree and says so.
 *
 * The result is the end of the output (within the cap), the exit code and the
 * path of the full output: the agent's copy (`spill`) when the log itself is
 * kept where the agent cannot reach it. Findings raised while the call runs (stuck, stale,
 * flooding, time-wasting, runaway memory, machine protection) are delivered
 * through `deliver`, which steers a running session: they reach the agent
 * right after the result. Options are read when used, so `root`, `prompts`
 * and the callbacks may be getters bound to an owner that exists later.
 */
export function createSupervisedBashTool(cwd: string, options: SupervisedBashOptions) {
	const definition = createBashToolDefinition(cwd);
	let current: ExperimentSupervisor | undefined;
	const supervisor = () => current ??= new ExperimentSupervisor({
		get root() { return options.root; },
		get env() { return options.env; },
		get prompts() { return options.prompts; },
		get spill() { return options.spill; },
		deliver: (text, update) => options.deliver(text, update),
		record: (eventType, payload) => options.record?.(eventType, payload),
		// Leftover processes of earlier calls keep their run open; they never block the next call.
		limits: { ...options.limits, maxConcurrent: Number.MAX_SAFE_INTEGER },
		...(options.protection ? { protection: options.protection } : {}),
		...(options.kill ? { kill: options.kill } : {}),
		...(options.memoryCeilingBytes !== undefined ? { memoryCeilingBytes: options.memoryCeilingBytes } : {}),
		environmentFingerprint: options.environmentFingerprint,
		pipelineRunId: options.pipelineRunId, stageInvocationId: options.stageInvocationId,
		blocking: true,
	});
	return { ...definition,
		/** Stop everything this tool's calls left running. A later call starts a fresh supervisor. */
		async close(): Promise<void> {
			const closing = current;
			current = undefined;
			await closing?.close();
		},
		async execute(toolCallId: string, args: { command: string; timeout?: number }, signal?: AbortSignal) {
			signal?.throwIfAborted();
			const owner = supervisor();
			const key = shellCommandKey(cwd, args.command);
			const id = `bash-${randomUUID().slice(0, 8)}`;
			const startedAt = Date.now();
			owner.start({ argv: options.argv?.(args.command) ?? ["bash", "-c", args.command], cwd,
				hypothesis: "agent shell call", scope: "shell", projectedDurationMs: shellProjection(key) }, toolCallId, id);
			const prompts = owner.notes;
			const timeoutMs = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout * 1000 : undefined;
			let cancelled = false;
			const abort = () => { cancelled = true; };
			signal?.addEventListener("abort", abort, { once: true });
			let timedOut = false;
			try {
				while (!owner.commandExit(id).ended) {
					if (cancelled || signal?.aborted) {
						await owner.stop(id, "owning session cancelled");
						owner.release(id);
						signal?.throwIfAborted();
						throw new Error("Shell call cancelled");
					}
					const left = timeoutMs === undefined ? Infinity : startedAt + timeoutMs - Date.now();
					if (left <= 0) {
						timedOut = true;
						await owner.stop(id, prompts.render("experiments.shell-timeout", { seconds: String(args.timeout) }).text);
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(owner.limits.sampleIntervalMs, 25, left))));
				}
			} finally {
				signal?.removeEventListener("abort", abort);
			}
			const exit = owner.commandExit(id);
			const remaining = timedOut ? [] : owner.remaining(id);
			// Nothing left: the launcher is ending; wait (briefly) so the result reports the finished run.
			for (const deadline = Date.now() + 1_000; !remaining.length && owner.status(id).status === "running" && Date.now() < deadline;) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const view = owner.status(id);
			if (!timedOut && !view.stopReason && exit.exitCode !== undefined) recordShellDuration(key, Date.now() - startedAt);
			const ending = [
				...(view.stopReason ? [prompts.render("experiments.shell-stopped", { reason: view.stopReason }).text] : []),
				prompts.render("experiments.shell-result", { exitCode: exit.exitCode !== undefined ? String(exit.exitCode) : exit.signal ?? view.status, logPath: view.logPath }).text,
				...(remaining.length ? [prompts.render("experiments.shell-background", { count: String(remaining.length), pids: remaining.join(" ") }).text] : []),
			].join("\n");
			options.record?.("shell_call_returned", { experiment_id: id, exit_code: exit.exitCode, signal: exit.signal,
				timed_out: timedOut, stop_reason: view.stopReason, remaining_pids: remaining, elapsed_ms: Date.now() - startedAt });
			const cap = owner.limits.outputCapBytes;
			// Sized for the largest possible omission, so the whole response fits the cap.
			const notice = (omitted: number) => prompts.render("experiments.shell-truncated", { omittedBytes: String(omitted), logPath: view.logPath }).text;
			const reserve = Buffer.byteLength(`${notice(Number.MAX_SAFE_INTEGER)}\n\n${ending}`);
			// The end of the output is kept: that is where a traceback or a result is.
			const tail = owner.tail(id, Math.max(0, cap - reserve));
			// The agent's copy of the full log is written now; the harness reads only its own descriptor.
			owner.release(id);
			const text = `${tail.omittedBytes > 0 ? `${notice(tail.omittedBytes)}\n` : ""}${tail.text}${tail.text.endsWith("\n") || !tail.text ? "" : "\n"}${ending}`;
			return { content: [{ type: "text" as const, text }],
				details: { ...view, exitCode: exit.exitCode, signal: exit.signal, timedOut, remainingPids: remaining,
					spillPath: view.logPath, omittedBytes: tail.omittedBytes } };
		},
	};
}
