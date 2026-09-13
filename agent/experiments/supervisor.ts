/**
 * Holds trial fits so the agent does not have to.
 *
 * In the Pi session model a tool call *is* ownership: a process started inside
 * one lives and dies inside it, and the agent reaches no model-call boundary
 * until the call returns. So a fit started that way cannot be observed while it
 * runs, cannot be stopped on evidence, and ends when its turn does. Here the
 * agent holds an ID and the supervisor holds the process, and the fit's lifetime
 * stops being bounded by a tool call, a turn, or context compaction.
 *
 * The log file is the record. There is no event ledger and no typed event union:
 * lifecycle and decisions are mirrored through `StageReporter.event`, which
 * already carries the shared identity.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { UpdateGate, renderUpdate } from "./updates.js";
import { groupAlive, sampleAvailable, sampleGroup } from "./sampler.js";
import {
	DEFAULT_LIMITS,
	type ExperimentRecord, type ExperimentSpec, type ExperimentStatus, type ExperimentView,
	type ResourceSample, type SupervisorLimits, type Update,
} from "./types.js";

export interface SupervisorOptions {
	/** Directory experiments are recorded under, normally `runs/<task>/experiments`. */
	root: string;
	/** Environment snapshot handed to every child. `process.env` is never mutated. */
	env: Record<string, string>;
	/** Delivers one coalesced update to the agent. Exactly one channel, never both. */
	deliver: (text: string, update: Update) => void | Promise<void>;
	/** Lifecycle and decisions, mirrored under the shared pipeline identity. */
	record?: (eventType: string, payload: Record<string, unknown>) => void;
	limits?: Partial<SupervisorLimits>;
	/** From `readPythonEnvironment()`. Recorded, not rebuilt. */
	environmentFingerprint?: string;
	pipelineRunId?: string;
	stageInvocationId?: string;
	/** Resident bytes worth interrupting for. */
	memoryCeilingBytes?: number;
}

interface Live {
	record: ExperimentRecord;
	child: ChildProcess;
	gate: UpdateGate;
	status: ExperimentStatus;
	startedAt: number;
	lines: number;
	pending: string[];
	lastLine?: string;
	lastLineAt?: number;
	sample?: ResourceSample;
	exitCode?: number;
	stopReason?: string;
	timer?: ReturnType<typeof setInterval>;
	logBytes: number;
	stopping?: Promise<void>;
}

export class ExperimentSupervisor {
	readonly limits: SupervisorLimits;
	private readonly live = new Map<string, Live>();

	constructor(private readonly options: SupervisorOptions) {
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		mkdirSync(options.root, { recursive: true });
	}

	list(): ExperimentView[] {
		return [...this.live.values()].map((entry) => this.view(entry));
	}

	status(id: string): ExperimentView {
		return this.view(this.require(id));
	}

	/**
	 * Spawn detached in its own process group and return immediately.
	 *
	 * Everything needed to attribute a stray process later is written before the
	 * spawn, because a process that outlives its supervisor is exactly the case
	 * where the record cannot be written afterwards.
	 */
	start(spec: ExperimentSpec, requestedByToolCallId?: string): ExperimentView {
		const running = [...this.live.values()].filter((entry) => entry.status === "running").length;
		if (running >= this.limits.maxConcurrent) {
			throw new Error(`${running} experiment(s) already running; stop one before starting another`);
		}
		if (spec.argv.length === 0) throw new Error("argv must name an executable");
		if (!existsSync(spec.cwd)) throw new Error(`working directory does not exist: ${spec.cwd}`);
		if (!spec.scope.trim()) throw new Error("scope must say what work this trial actually does");

		const id = randomUUID().slice(0, 8);
		const directory = join(this.options.root, id);
		mkdirSync(directory, { recursive: true });
		const logPath = join(directory, "output.log");
		writeFileSync(logPath, "");

		const child = spawn(spec.argv[0], spec.argv.slice(1), {
			cwd: spec.cwd,
			// Its own process group. `n_jobs > 1` means joblib workers, and killing
			// only the parent orphans them to burn CPU into the next iteration.
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...this.options.env,
				// Without this a child's stdout is block-buffered when it is not a
				// tty, so `verbose` output arrives in 8 KB chunks or at exit --
				// reproducing the exact problem this module exists to fix.
				PYTHONUNBUFFERED: "1",
			},
		});
		const pgid = child.pid ?? 0;
		const record: ExperimentRecord = {
			...spec, id, pid: child.pid ?? 0, pgid,
			startedAt: new Date().toISOString(), directory, logPath,
			environmentFingerprint: this.options.environmentFingerprint,
			pipelineRunId: this.options.pipelineRunId,
			stageInvocationId: this.options.stageInvocationId,
			requestedByToolCallId,
		};
		writeFileSync(join(directory, "experiment.json"), `${JSON.stringify(record, null, 2)}\n`);

		const startedAt = Date.now();
		const entry: Live = {
			record, child, startedAt, status: "running", lines: 0, pending: [], logBytes: 0,
			gate: new UpdateGate(this.limits, startedAt, spec.expectedGapMs, this.options.memoryCeilingBytes),
		};
		this.live.set(id, entry);

		this.drain(entry, child.stdout);
		this.drain(entry, child.stderr);
		child.on("error", (error) => {
			entry.status = "failed";
			entry.stopReason = `spawn failed: ${error.message}`;
			this.finish(entry);
		});
		child.on("exit", (code, signal) => {
			entry.exitCode = code ?? undefined;
			if (entry.status === "running") entry.status = signal ? "stopped" : "exited";
			// The group can outlive the parent: joblib workers are the reason this
			// waits rather than declaring the trial over here.
			setTimeout(() => this.finish(entry), 50);
		});
		entry.timer = setInterval(() => this.tick(entry), this.limits.sampleIntervalMs);
		entry.timer.unref?.();

		this.options.record?.("experiment_started", {
			experiment_id: id, pid: record.pid, pgid, scope: spec.scope, hypothesis: spec.hypothesis,
			argv: spec.argv, cwd: spec.cwd, expected_gap_ms: spec.expectedGapMs,
			environment_fingerprint: record.environmentFingerprint,
			sampling: sampleAvailable() ? "libproc" : "unavailable",
			directory,
		});
		return this.view(entry);
	}

	/**
	 * Signal the whole process group, then confirm it is gone.
	 *
	 * `kill(-pgid)`, never `kill(pid)`. Repeating it is a no-op rather than an
	 * error, because an agent that stopped a trial and asks again should be told
	 * the same thing it was told the first time.
	 */
	async stop(id: string, reason: string, observations: string[] = []): Promise<ExperimentView> {
		const entry = this.require(id);
		if (entry.status !== "running") return this.view(entry);
		entry.stopReason = reason;
		this.options.record?.("experiment_stop_requested", {
			experiment_id: id, reason, observations,
			elapsed_seconds: (Date.now() - entry.startedAt) / 1000,
			lines_emitted: entry.lines,
		});
		entry.stopping ??= (async () => {
			this.signalGroup(entry, "SIGTERM");
			await new Promise((settle) => setTimeout(settle, this.limits.stopGraceMs));
			if (groupAlive(entry.record.pgid)) this.signalGroup(entry, "SIGKILL");
		})();
		await entry.stopping;
		entry.status = "stopped";
		this.finish(entry);
		return this.view(entry);
	}

	/**
	 * Log bytes from `cursor` on.
	 *
	 * Reading forward from a cursor is what lets observation resume across a
	 * model turn or a compaction without replaying the whole metric history into
	 * the model's context.
	 */
	output(id: string, cursor = 0, maxBytes = 8_192): { text: string; cursor: number; remaining: number } {
		const entry = this.require(id);
		const size = existsSync(entry.record.logPath) ? statSync(entry.record.logPath).size : 0;
		const from = Math.max(0, Math.min(cursor, size));
		const length = Math.min(maxBytes, size - from);
		if (length <= 0) return { text: "", cursor: size, remaining: 0 };
		const buffer = Buffer.alloc(length);
		const handle = openSync(entry.record.logPath, "r");
		try {
			readSync(handle, buffer, 0, length, from);
		} finally {
			closeSync(handle);
		}
		return { text: buffer.toString("utf8"), cursor: from + length, remaining: size - (from + length) };
	}

	/** Stop everything still running. A detached process outliving the run is the failure mode. */
	async close(): Promise<void> {
		await Promise.all([...this.live.keys()].map((id) => this.stop(id, "supervisor closed").catch(() => undefined)));
	}

	private signalGroup(entry: Live, signal: NodeJS.Signals): void {
		try {
			process.kill(-entry.record.pgid, signal);
		} catch {
			// Already gone, or never started. Both are the state stop asks for.
		}
	}

	private require(id: string): Live {
		const entry = this.live.get(id);
		if (!entry) throw new Error(`no experiment with id ${id}`);
		return entry;
	}

	/** Line by line, straight to the log. Partial lines wait for their newline. */
	private drain(entry: Live, stream: NodeJS.ReadableStream | null): void {
		if (!stream) return;
		let carry = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			carry += chunk;
			let index = carry.indexOf("\n");
			while (index >= 0) {
				this.line(entry, carry.slice(0, index));
				carry = carry.slice(index + 1);
				index = carry.indexOf("\n");
			}
			// A very long line with no newline would otherwise grow without bound.
			if (carry.length > 64 * 1024) {
				this.line(entry, carry);
				carry = "";
			}
		});
		stream.on("end", () => { if (carry.length) this.line(entry, carry); });
	}

	private line(entry: Live, text: string): void {
		const at = Date.now();
		entry.lines++;
		entry.lastLine = text;
		entry.lastLineAt = at;
		entry.pending.push(text);
		entry.gate.observeLine(at);
		const encoded = `${text}\n`;
		entry.logBytes += Buffer.byteLength(encoded);
		try {
			appendFileSync(entry.record.logPath, encoded);
		} catch {
			// A log write that fails must not stop ingestion or kill the fit.
		}
	}

	private tick(entry: Live): void {
		if (entry.status === "running") {
			entry.sample = sampleGroup(entry.record.pgid, entry.sample) ?? entry.sample;
		}
		const exited = entry.status !== "running";
		const update = entry.gate.decide({
			now: Date.now(), view: this.view(entry), sample: entry.sample, pending: entry.pending, exited,
		});
		if (!update) return;
		entry.pending = [];
		this.options.record?.("experiment_update", {
			experiment_id: entry.record.id, kind: update.kind, note: update.note,
			elapsed_seconds: update.view.elapsedSeconds, cpu_percent: update.view.cpuPercent,
			rss_mb: update.view.rssMb, lines_emitted: update.view.linesEmitted,
			stall_threshold_ms: entry.gate.stallThresholdMs(),
		});
		void Promise.resolve(this.options.deliver(renderUpdate(update), update)).catch(() => undefined);
	}

	private finish(entry: Live): void {
		if (entry.timer) {
			clearInterval(entry.timer);
			entry.timer = undefined;
		}
		if (entry.status === "running") entry.status = "exited";
		// One last pass so the exit itself, and whatever it printed on the way
		// out, still reach the agent.
		this.tick(entry);
		this.options.record?.("experiment_finished", {
			experiment_id: entry.record.id, status: entry.status, exit_code: entry.exitCode,
			stop_reason: entry.stopReason, lines_emitted: entry.lines,
			elapsed_seconds: (Date.now() - entry.startedAt) / 1000,
			group_alive: groupAlive(entry.record.pgid),
		});
	}

	private view(entry: Live): ExperimentView {
		const now = Date.now();
		return {
			id: entry.record.id,
			status: entry.status,
			scope: entry.record.scope,
			hypothesis: entry.record.hypothesis,
			elapsedSeconds: (now - entry.startedAt) / 1000,
			linesEmitted: entry.lines,
			cursor: entry.logBytes,
			exitCode: entry.exitCode,
			stopReason: entry.stopReason,
			lastLine: entry.lastLine,
			secondsSinceOutput: entry.lastLineAt ? (now - entry.lastLineAt) / 1000 : undefined,
			cpuPercent: entry.sample?.cpuPercent,
			rssMb: entry.sample ? entry.sample.rssBytes / 1024 ** 2 : undefined,
			processes: entry.sample?.processes,
			stalled: entry.status === "running"
				&& entry.gate.silenceMs(now) >= entry.gate.stallThresholdMs()
				&& (entry.sample?.cpuPercent ?? 100) < this.limits.idleCpuPercent,
			logPath: entry.record.logPath,
		};
	}
}
