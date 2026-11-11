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

import { machineProtection, type MachineProtection, type ProtectedWork } from "./protection.js";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { atomicJson, processIdentity, ownedProcessAlive, liveGroup, type ProcessIdentity } from "./ownership.js";
import { loadPromptSnapshot, type PromptReference, type PromptSnapshot } from "../prompts/loader.js";
import type { PromptId } from "../prompts/registry.js";

import { UpdateGate, renderUpdate } from "./updates.js";
import { groupAlive, groupRunning, libproc, linuxSystem, processSnapshot, processTree, sampleGroup, type MachineSample } from "./sampler.js";
import { decodePrefix, fileSize, readRange, readTail } from "./text.js";
import {
	DEFAULT_LIMITS,
	type ExperimentRecord, type ExperimentSpec, type ExperimentStatus, type ExperimentView,
	type ResourceSample, type SupervisorLimits, type Update, type UpdateKind,
} from "./types.js";

export interface SupervisorOptions {
	/** Directory experiments are recorded under, normally `runs/<task>/experiments`. */
	root: string;
	/** Environment snapshot handed to every child. `process.env` is never mutated. */
	env: Record<string, string>;
	/** Delivers one coalesced update to the agent. Exactly one channel, never both. */
	deliver: (text: string, update: Update) => void | Promise<void>;
	/**
	 * The run's prompt snapshot: every note an agent reads is rendered from it.
	 * Owners without one (refit, confirmation) get the templates loaded once per
	 * process; the rendered reference is recorded either way.
	 */
	prompts?: PromptSnapshot;
	/** Lifecycle and decisions, mirrored under the shared pipeline identity. */
	record?: (eventType: string, payload: Record<string, unknown>) => void;
	limits?: Partial<SupervisorLimits>;
	/** Test seam: production uses the shared machine arbiter. */
	protection?: MachineProtection;
	/** From `readPythonEnvironment()`. Recorded, not rebuilt. */
	environmentFingerprint?: string;
	pipelineRunId?: string;
	stageInvocationId?: string;
	/** Resident bytes worth interrupting for. */
	memoryCeilingBytes?: number;
	/**
	 * The owner waits for each process inside one tool call (a shell call). The
	 * tool result reports the exit and the output, so only findings while the
	 * call runs are delivered: no exit, diagnostic or flooding update.
	 */
	blocking?: boolean;
	/** Called once per experiment after its process group is gone, for harness bookkeeping. */
	onFinished?: (id: string, view: ExperimentView) => void | Promise<void>;
}

let processPrompts: PromptSnapshot | undefined;

/** The note template for each kind of update. */
const NOTE_PROMPTS: Partial<Record<UpdateKind, PromptId>> = {
	exited: "experiments.note-exited",
	diagnostic: "experiments.note-diagnostic",
	memory: "experiments.note-memory",
	stalled: "experiments.note-stalled",
	stale: "experiments.note-stale",
	flooding: "experiments.note-flooding",
	"time-wasting": "experiments.note-time-wasting",
};

interface Live {
	record: ExperimentRecord;
	child?: ChildProcess;
	identity?: ProcessIdentity;
	token?: string;
	gate: UpdateGate;
	status: ExperimentStatus;
	startedAt: number;
	/** Set when the process group is gone: elapsed time stops here. */
	endedAt?: number;
	lines: number;
	/** Lines since the last decision; matched for diagnostics, then cleared. */
	pending: string[];
	/** The last few lines of the run, never cleared: exit reports carry them. */
	recent: string[];
	lastLine?: string;
	lastLineAt?: number;
	sample?: ResourceSample;
	exitCode?: number;
	stopReason?: string;
	timer?: ReturnType<typeof setInterval>;
	logBytes: number;
	stopping?: Promise<void>;
	finished?: boolean;
	protectedWork?: ProtectedWork;
	unregister?: () => void;
}

export class ExperimentSupervisor {
	readonly limits: SupervisorLimits;
	private readonly live = new Map<string, Live>();
	private closed = false;

	constructor(private readonly options: SupervisorOptions) {
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		options.record?.("supervisor_configuration", { limits: this.limits, blocking: options.blocking === true });
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
	start(spec: ExperimentSpec, requestedByToolCallId?: string, requestedId?: string, retainedDirectory?: string): ExperimentView {
		if (this.closed) throw new Error("supervisor is closed");
		const running = [...this.live.values()].filter((entry) => entry.status === "running").length;
		if (running >= this.limits.maxConcurrent) {
			throw new Error(`${running} experiment(s) already running; stop one before starting another`);
		}
		if (spec.argv.length === 0) throw new Error("argv must name an executable");
		if (!existsSync(spec.cwd)) throw new Error(`working directory does not exist: ${spec.cwd}`);
		if (!spec.scope.trim()) throw new Error("scope must say what work this trial actually does");

		const id = requestedId ?? randomUUID().slice(0, 8);
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
			throw new Error("experiment id must contain 1..64 letters, digits, underscores, or hyphens");
		}
		if (this.live.get(id)?.status === "running") throw new Error(`experiment ${id} already exists and is running`);
		const directory = retainedDirectory ?? join(this.options.root, id);
		mkdirSync(directory, { recursive: true });
		const logPath = join(directory, "output.log");
		const logFd = openSync(logPath, "a", 0o600);

		const child = spawn(spec.argv[0], spec.argv.slice(1), {
			cwd: spec.cwd,
			// Its own process group. `n_jobs > 1` means joblib workers, and killing
			// only the parent orphans them to burn CPU into the next iteration.
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: {
				...this.options.env,
				// Without this a child's stdout is block-buffered when it is not a
				// tty, so `verbose` output arrives in 8 KB chunks or at exit --
				// reproducing the exact problem this module exists to fix.
				PYTHONUNBUFFERED: "1",
			},
		});
		closeSync(logFd);
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
			record, child, identity: processIdentity(pgid), startedAt, status: "running", lines: 0, pending: [], recent: [],
			logBytes: fileSize(logPath), gate: this.gate(startedAt, spec.expectedGapMs),
		};
		this.live.set(id, entry);
		this.protect(entry);
		this.persist(entry);

		this.drain(entry, child.stdout);
		this.drain(entry, child.stderr);
		child.on("error", (error) => {
			entry.status = "failed";
			entry.stopReason = `spawn failed: ${error.message}`;
			this.finish(entry);
		});
		child.on("exit", (code, signal) => {
			entry.exitCode = code ?? undefined;
			// Only explicit stop is intentional; an unexpected signal is interrupted.
			if (entry.status === "running") entry.exitCode = code ?? (signal ? -1 : undefined);
			// The group can outlive the parent: joblib workers are the reason this
			// waits rather than declaring the trial over here.
			setTimeout(() => this.finish(entry), 50);
		});
		entry.timer = setInterval(() => this.tick(entry), this.limits.sampleIntervalMs);
		entry.timer.unref?.();

		this.options.record?.("experiment_started", {
			experiment_id: id, pid: record.pid, pgid, scope: spec.scope, hypothesis: spec.hypothesis,
			argv: spec.argv, cwd: spec.cwd, expected_gap_ms: spec.expectedGapMs,
			projected_duration_ms: spec.projectedDurationMs,
			environment_fingerprint: record.environmentFingerprint,
			sampling: process.platform === "linux" ? (linuxSystem() ? "proc" : "unavailable") : libproc() ? "libproc" : "unavailable",
			directory,
		});
		return this.view(entry);
	}

	/**
	 * Signal the process tree, then confirm it is gone.
	 *
	 * The tree is the process group plus descendants that left it (`setsid`)
	 * while their parent lives: the same members the sampler measures and
	 * machine protection chooses by. Each is captured with its birth identity
	 * before the first signal, so a member that the SIGTERM orphans still gets
	 * the SIGKILL, and a reused PID never does. Repeating a stop is a no-op
	 * rather than an error, because an agent that stopped a trial and asks again
	 * should be told the same thing it was told the first time.
	 */
	async stop(id: string, reason: string, observations: string[] = []): Promise<ExperimentView> {
		const entry = this.require(id);
		if (entry.status !== "running") return this.view(entry);
		entry.stopReason = reason;
		this.persist(entry);
		this.options.record?.("experiment_stop_requested", {
			experiment_id: id, reason, observations,
			elapsed_seconds: (Date.now() - entry.startedAt) / 1000,
			lines_emitted: entry.lines,
		});
		entry.stopping ??= (async () => {
			const targets = this.stopTargets(entry);
			this.signalTree(entry, targets, "SIGTERM");
			await new Promise((settle) => setTimeout(settle, this.limits.stopGraceMs));
			const remaining = [...targets, ...this.stopTargets(entry)];
			if (groupAlive(entry.record.pgid) || remaining.some((target) => ownedProcessAlive(target))) {
				this.signalTree(entry, remaining, "SIGKILL");
			}
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
	 * the model's context. The cursor stops before a character the cap would cut,
	 * so the next read starts on it and no byte is skipped.
	 */
	output(id: string, cursor = 0, maxBytes = 8_192): { text: string; cursor: number; remaining: number } {
		const entry = this.require(id);
		const size = fileSize(entry.record.logPath);
		const from = Math.max(0, Math.min(cursor, size));
		const cap = Math.min(maxBytes, this.limits.outputCapBytes);
		const length = Math.min(cap, size - from);
		if (length <= 0) return { text: "", cursor: size, remaining: 0 };
		let buffer: Buffer;
		try { buffer = readRange(entry.record.logPath, from, length); }
		catch { return { text: "", cursor: from, remaining: size - from }; }
		let { text, bytes } = decodePrefix(buffer, cap);
		// Only a character still being written may wait for its remaining bytes.
		const finished = entry.status !== "running" || from + buffer.length < size;
		if (bytes === 0 && finished) {
			text = buffer.toString("utf8");
			bytes = buffer.length;
		}
		return { text, cursor: from + bytes, remaining: size - (from + bytes) };
	}

	/** The end of the log within `maxBytes`, for a blocking call's result. */
	tail(id: string, maxBytes: number): { text: string; omittedBytes: number; logPath: string } {
		const entry = this.require(id);
		return { ...readTail(entry.record.logPath, Math.min(maxBytes, this.limits.outputCapBytes)), logPath: entry.record.logPath };
	}

	/** Stop everything still running. A detached process outliving the run is the failure mode. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.live.keys()].map((id) => this.stop(id, "supervisor closed").catch(() => undefined)));
	}

	/** Reattach logs, liveness polling and control without spawning anything. */
	attach(record: ExperimentRecord, state: { identity?: ProcessIdentity; stopReason?: string; status?: ExperimentStatus; cursor?: number; lines?: number }): ExperimentView {
		if (this.live.has(record.id)) return this.status(record.id);
		const startedAt = Date.parse(record.startedAt);
		const entry: Live = { record, identity: state.identity, startedAt, status: state.status ?? "running",
			stopReason: state.stopReason, logBytes: state.cursor ?? 0, lines: state.lines ?? 0, pending: [], recent: [],
			gate: this.gate(startedAt, record.expectedGapMs) };
		this.live.set(record.id, entry);
		if (entry.status === "running") {
			this.protect(entry);
			entry.timer = setInterval(() => this.tick(entry), this.limits.sampleIntervalMs);
			entry.timer.unref?.();
		} else {
			entry.finished = true;
			entry.endedAt = startedAt;
		}
		this.options.record?.("experiment_reattached", { experiment_id: record.id,
			origin_pipeline_run_id: record.pipelineRunId, origin_stage_invocation_id: record.stageInvocationId,
			cursor: entry.logBytes, status: entry.status });
		return this.view(entry);
	}

	notify(id: string, note: string): void {
		const entry = this.live.get(id);
		if (!entry) return;
		const update: Update = { kind: "diagnostic", id, at: Date.now(), lines: [], view: this.view(entry), note };
		void Promise.resolve(this.options.deliver(renderUpdate(update), update)).catch(() => undefined);
	}

	private gate(startedAt: number, expectedGapMs?: number): UpdateGate {
		return new UpdateGate(this.limits, startedAt, {
			expectedGapMs, memoryCeilingBytes: this.options.memoryCeilingBytes, blocking: this.options.blocking,
		});
	}

	/** The snapshot notes are rendered from. */
	get notes(): PromptSnapshot {
		return this.options.prompts ?? (processPrompts ??= loadPromptSnapshot());
	}

	private get protection(): MachineProtection {
		return this.options.protection ?? machineProtection;
	}

	/** `maxAgeMs: 0` for decisions that must not act on a reading from before a signal. */
	private groupRunning(entry: Live, maxAgeMs?: number): boolean {
		if (process.platform === "darwin") return liveGroup(entry.record.pgid).length > 0;
		return groupRunning(entry.record.pgid, maxAgeMs);
	}

	/** Every live member of the tree, with birth identities. Empty unless the leader is verifiably ours. */
	private stopTargets(entry: Live): ProcessIdentity[] {
		if (process.platform !== "linux" || !ownedProcessAlive(entry.identity)) return [];
		try {
			return processTree(entry.record.pgid, processSnapshot("/proc", 0).processes)
				.map((member) => processIdentity(member.pid))
				.filter((identity): identity is ProcessIdentity => identity !== undefined);
		} catch {
			return [];
		}
	}

	private signalTree(entry: Live, targets: ProcessIdentity[], signal: NodeJS.Signals): void {
		this.signalGroup(entry, signal);
		for (const target of targets) {
			// Checked again at the moment of signalling: never signal a reused PID.
			if (!ownedProcessAlive(target)) continue;
			try { process.kill(target.pid, signal); } catch { /* already gone */ }
		}
	}

	private persist(entry: Live): void {
		atomicJson(join(entry.record.directory, "supervisor-state.json"), {
			schemaVersion: 1, status: entry.status, stopReason: entry.stopReason, identity: entry.identity,
			cursor: entry.logBytes, lines: entry.lines, exitCode: entry.exitCode,
		});
	}

	private remember(entry: Live, lines: string[]): void {
		const clipped = lines.map((line) => line.slice(0, 300));
		entry.pending.push(...clipped);
		entry.pending = entry.pending.slice(-Math.max(this.limits.linesPerUpdate, 64));
		entry.recent.push(...clipped);
		entry.recent = entry.recent.slice(-this.limits.linesPerUpdate);
	}

	/**
	 * Read new log lines. While running, one 64 KiB chunk a tick and whole lines
	 * only: a line still being written is read on a later tick. The final pass
	 * reads to the end, so an exit report carries the lines the run ended with.
	 */
	private tailLog(entry: Live, final = false): void {
		do {
			if (!this.readChunk(entry, final)) break;
		} while (final);
	}

	private readChunk(entry: Live, final: boolean): boolean {
		const size = fileSize(entry.record.logPath);
		if (size <= entry.logBytes) return false;
		let buffer: Buffer;
		try { buffer = readRange(entry.record.logPath, entry.logBytes, Math.min(size - entry.logBytes, 65536)); }
		catch { return false; }
		const end = buffer.lastIndexOf(0x0a) + 1;
		const consumed = end > 0 ? end : buffer.length >= 65536 || final ? buffer.length : 0;
		if (consumed === 0) return false;
		entry.logBytes += consumed;
		const lines = buffer.subarray(0, consumed).toString("utf8").split("\n").filter(Boolean);
		entry.lines += lines.length;
		this.remember(entry, lines);
		if (lines.length) {
			entry.lastLine = lines.at(-1); entry.lastLineAt = Date.now(); entry.gate.observeLine(entry.lastLineAt);
		}
		this.persist(entry);
		return true;
	}

	private signalGroup(entry: Live, signal: NodeJS.Signals): void {
		try {
			// Never signal a reused PID/group. Descendants without a live verified
			// leader block recovery but require operator intervention to stop.
			if (!ownedProcessAlive(entry.identity)) return;
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
		this.remember(entry, [text]);
		entry.gate.observeLine(at);
		const encoded = `${text}\n`;
		entry.logBytes += Buffer.byteLength(encoded);
		try {
			appendFileSync(entry.record.logPath, encoded);
		} catch {
			// A log write that fails must not stop ingestion or kill the fit.
		}
	}

	private protect(entry: Live): void {
		const work: ProtectedWork = { rssBytes: 0, peakBytes: 0, largestProcessBytes: 0,
			refresh: () => {
				const sample = sampleGroup(entry.record.pgid);
				if (!sample) { work.rssBytes = 0; work.largestProcessBytes = 0; return; }
				work.rssBytes = sample.rssBytes;
				work.peakBytes = Math.max(work.peakBytes, work.rssBytes);
				work.largestProcessBytes = sample.largestProcessBytes ?? sample.rssBytes;
			},
			stop: async (peak) => {
				const rendered = this.notes.render("experiments.machine-at-risk", { peakMb: (peak / 1024 ** 2).toFixed(0) });
				const note = rendered.text;
				const update: Update = { kind: "machine-at-risk", id: entry.record.id, at: Date.now(), lines: [...entry.recent], view: this.view(entry), note };
				this.options.record?.("experiment_machine_protection", { experiment_id: entry.record.id, peak_bytes: peak, prompt: rendered.reference });
				// Mark the durable stop before signalling so recovery will not restart it.
				const stopped = this.stop(entry.record.id, note);
				void Promise.resolve(this.options.deliver(renderUpdate(update), update)).catch(() => undefined);
				await stopped;
			} };
		entry.protectedWork = work;
		entry.unregister = this.protection.register(work);
	}

	private tick(entry: Live): void {
		this.tailLog(entry);
		if (!entry.finished && !ownedProcessAlive(entry.identity) && !this.groupRunning(entry)) {
			this.finish(entry);
			return;
		}
		let machine: MachineSample | undefined;
		if (entry.status === "running") {
			// One /proc scan serves the sample, the protection refresh and the liveness check.
			entry.sample = sampleGroup(entry.record.pgid, entry.sample) ?? entry.sample;
			entry.protectedWork?.refresh?.();
			try { machine = this.protection.machine(); } catch { machine = undefined; }
			void this.protection.check().catch(() => undefined);
		}
		this.decide(entry, machine);
	}

	private decide(entry: Live, machine?: MachineSample): void {
		const update = entry.gate.decide({
			now: Date.now(), view: this.view(entry), sample: entry.sample,
			pending: entry.pending, recent: entry.recent, exited: entry.status !== "running",
			projectedDurationMs: entry.record.projectedDurationMs, outputBytes: fileSize(entry.record.logPath),
			...(machine ? { machine: { availableBytes: machine.availableBytes, reserveBytes: this.protection.reserveBytes } } : {}),
		});
		entry.pending = [];
		if (!update) return;
		let prompt: PromptReference | undefined;
		const promptId = NOTE_PROMPTS[update.kind];
		if (promptId && update.facts) {
			const rendered = this.notes.render(promptId, update.facts as never);
			update.note = rendered.text;
			prompt = rendered.reference;
		}
		this.options.record?.("experiment_update", {
			experiment_id: entry.record.id, kind: update.kind, note: update.note, facts: update.facts, prompt,
			elapsed_seconds: update.view.elapsedSeconds, cpu_percent: update.view.cpuPercent,
			rss_mb: update.view.rssMb, lines_emitted: update.view.linesEmitted,
			stall_threshold_ms: entry.gate.stallThresholdMs(),
		});
		void Promise.resolve(this.options.deliver(renderUpdate(update), update)).catch(() => undefined);
	}

	private finish(entry: Live): void {
		if (entry.finished) return;
		if (this.groupRunning(entry, 0)) return;
		this.tailLog(entry, true);
		entry.unregister?.();
		if (entry.timer) {
			clearInterval(entry.timer);
			entry.timer = undefined;
		}
		if (entry.status === "running") entry.status = "exited";
		entry.endedAt ??= Date.now();
		// One last pass so the exit itself, and whatever it printed on the way
		// out, still reach the agent.
		entry.finished = true;
		this.persist(entry);
		this.decide(entry);
		this.options.record?.("experiment_finished", {
			experiment_id: entry.record.id, status: entry.status, exit_code: entry.exitCode,
			stop_reason: entry.stopReason, lines_emitted: entry.lines,
			elapsed_seconds: (entry.endedAt - entry.startedAt) / 1000,
			group_alive: groupAlive(entry.record.pgid),
		});
		void Promise.resolve(this.options.onFinished?.(entry.record.id, this.view(entry))).catch(() => undefined);
	}

	private view(entry: Live): ExperimentView {
		const now = Date.now();
		return {
			id: entry.record.id,
			status: entry.status,
			scope: entry.record.scope,
			hypothesis: entry.record.hypothesis,
			elapsedSeconds: ((entry.endedAt ?? now) - entry.startedAt) / 1000,
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
