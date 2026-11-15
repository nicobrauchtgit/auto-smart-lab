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
 *
 * An experiment's directory (log, launcher status, state, record) belongs to
 * the harness: owners place it outside every mount a supervised command can
 * write. The log is opened once, never through a symlink, and read only
 * through that descriptor; status and state are read without following a
 * symlink. An agent that needs the log as a file gets a copy (`spill`), which
 * is never read back.
 */

import { machineProtection, type MachineProtection, type ProtectedWork } from "./protection.js";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, rmSync, writeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import {
	atomicJson, confirmedTargets, ownedMembers, processIdentity, ownedProcessAlive, liveGroup, sameProcessAlive,
	type ProcessIdentity,
} from "./ownership.js";
import { loadPromptSnapshot, type PromptReference, type PromptSnapshot } from "../prompts/loader.js";
import type { PromptId } from "../prompts/registry.js";

import { UpdateGate, renderUpdate, type GateState } from "./updates.js";
import {
	groupAlive, groupRunning, libproc, linuxSystem, processSnapshot, sampleGroup, sampleProcesses, SNAPSHOT_REUSE_MS,
	type LinuxProcess, type MachineSample,
} from "./sampler.js";
import { decodePrefix, fileSize, readRange, readTail } from "./text.js";
import { COMMAND_STATUS_FILE, commandEnded, launchArgv, readCommandStatus, type CommandStatus } from "./launcher.js";
import { openLog, readRecordJson, writeCopy } from "./safe_files.js";
import {
	DEFAULT_LIMITS, MIN_OUTPUT_BYTES,
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
	/** Test seam for signal delivery: production uses `process.kill`. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	/**
	 * Where the agent reads each run's full output: a copy at
	 * `<directory>/<id>.log`, written from the harness's own descriptor when the
	 * owner releases the run and again when it finishes. `base` is a directory
	 * the agent cannot replace (a mount root); every component below it must be
	 * a real directory. Views then name the copy, never the harness's log.
	 */
	spill?: { base: string; directory: string };
}

/** What a reattached supervisor restores, in addition to the caller's view of the run. */
export interface AttachState {
	identity?: ProcessIdentity;
	stopReason?: string;
	status?: ExperimentStatus;
	cursor?: number;
	lines?: number;
	/** Reported kinds, output timing and learned gaps. Read from the run's state file when absent. */
	gate?: Partial<GateState>;
	/** Every process of the run tracked so far, by birth identity. Read from the run's state file when absent. */
	members?: ProcessIdentity[];
}

/**
 * One scan's view of a run: its live processes, when they were read, and
 * whether its process group still has live processes, verified or not.
 */
interface Scan { at: number; members: LinuxProcess[]; groupAlive: boolean }

let processPrompts: PromptSnapshot | undefined;

const isIdentity = (value: unknown): value is ProcessIdentity => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { pid, pgid, birth, state } = value as Record<string, unknown>;
	return Number.isSafeInteger(pid) && (pid as number) > 0 && Number.isSafeInteger(pgid)
		&& typeof birth === "string" && birth.length > 0 && typeof state === "string";
};

/**
 * The parts of a persisted or supplied state a reattach uses, each validated.
 * A malformed field is dropped (treated as absent) and named in `malformed`;
 * a malformed member is dropped from an otherwise valid list.
 */
export function restoredState(value: unknown): { state: { gate?: Partial<GateState>; members?: ProcessIdentity[] }; malformed: string[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { state: {}, malformed: ["state"] };
	const { gate, members } = value as Record<string, unknown>;
	const state: { gate?: Partial<GateState>; members?: ProcessIdentity[] } = {};
	const malformed: string[] = [];
	if (gate !== undefined) {
		if (gate && typeof gate === "object" && !Array.isArray(gate)) state.gate = gate as Partial<GateState>;
		else malformed.push("gate");
	}
	if (members !== undefined) {
		if (Array.isArray(members)) {
			state.members = members.filter(isIdentity);
			if (state.members.length !== members.length) malformed.push("members[]");
		} else malformed.push("members");
	}
	return { state, malformed };
}

/** The note template for each kind of update. */
const NOTE_PROMPTS: Partial<Record<UpdateKind, PromptId>> = {
	exited: "experiments.note-exited",
	diagnostic: "experiments.note-diagnostic",
	memory: "experiments.note-memory",
	stalled: "experiments.note-stalled",
	stale: "experiments.note-stale",
	flooding: "experiments.note-flooding",
	"time-wasting": "experiments.note-time-wasting",
	"busy-silence": "experiments.note-busy-silence",
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
	/**
	 * Every process of this run seen so far, keyed by PID and birth. Members stay
	 * tracked after the leader exits or after their link to the group is gone.
	 */
	members: Map<string, ProcessIdentity>;
	/** The process group is ours: spawned or verified here, and not seen empty since. */
	groupHeld: boolean;
	/** The command's own end (not its tree's): from the launcher's status file, or the child's exit without one. */
	command?: CommandStatus;
	/** The log, opened once without following a symlink; every read and write goes through it. */
	logFd?: number;
	/** The owner has read its result (`release`): the descriptor closes once the run is finished. */
	released?: boolean;
	/** The agent's copy of the log, when the owner configured one. */
	spillPath?: string;
}

/** Where the command itself stands, apart from processes it left behind. */
export interface CommandExit { ended: boolean; exitCode?: number; signal?: string }

const memberKey = (identity: ProcessIdentity) => `${identity.pid}:${identity.birth}`;
/** Whether anything, a symlink included, is at `path`. */
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

export class ExperimentSupervisor {
	readonly limits: SupervisorLimits;
	private readonly live = new Map<string, Live>();
	private closed = false;

	constructor(private readonly options: SupervisorOptions) {
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		if (!(this.limits.outputCapBytes >= MIN_OUTPUT_BYTES)) throw new RangeError(`outputCapBytes must be at least ${MIN_OUTPUT_BYTES}`);
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
		if (lstatSync(directory).isSymbolicLink()) throw new Error(`experiment directory is a symlink: ${directory}`);
		const logPath = join(directory, "output.log");
		// A retained directory may hold the status of an earlier attempt.
		const statusPath = join(directory, COMMAND_STATUS_FILE);
		rmSync(statusPath, { force: true });
		// Under the child subreaper every process the command leaves behind stays a
		// descendant of the group leader, so any later scan finds it through parent
		// links, however soon its own parent exited.
		const launch = launchArgv(statusPath, spec.argv);
		// Kept for the life of the run: the harness never reopens the log by path.
		const logFd = openLog(logPath);

		let child: ChildProcess;
		try {
			child = spawn(launch.argv[0], launch.argv.slice(1), {
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
		} catch (error) {
			closeSync(logFd);
			throw error;
		}
		const pgid = child.pid ?? 0;
		const record: ExperimentRecord = {
			...spec, id, pid: child.pid ?? 0, pgid,
			...(launch.launcher ? { launcher: launch.argv.slice(0, launch.argv.length - spec.argv.length) } : {}),
			startedAt: new Date().toISOString(), directory, logPath,
			environmentFingerprint: this.options.environmentFingerprint,
			pipelineRunId: this.options.pipelineRunId,
			stageInvocationId: this.options.stageInvocationId,
			requestedByToolCallId,
		};
		atomicJson(join(directory, "experiment.json"), record);

		const startedAt = Date.now();
		const entry: Live = {
			record, child, identity: processIdentity(pgid), startedAt, status: "running", lines: 0, pending: [], recent: [],
			logBytes: fileSize(logFd), gate: this.gate(startedAt, spec.expectedGapMs),
			members: new Map(), groupHeld: pgid > 0, logFd, spillPath: this.spillPath(id),
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
			if (record.launcher) {
				// The launcher ends only after the whole tree; the command's own exit is in its status file.
				const command = this.commandStatus(entry);
				if (command?.exitCode !== undefined) code = command.exitCode;
				else if (command?.signal) { code = null; signal = command.signal as NodeJS.Signals; }
			} else {
				entry.command = { pid: record.pid, ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signal } : {}) };
			}
			entry.exitCode = code ?? undefined;
			// Only explicit stop is intentional; an unexpected signal is interrupted.
			if (entry.status === "running") entry.exitCode = code ?? (signal ? -1 : undefined);
			// The group can outlive the parent: joblib workers are the reason this
			// waits rather than declaring the trial over here.
			setTimeout(() => this.finish(entry), 50);
		});
		entry.timer = setInterval(() => this.safeTick(entry), this.limits.sampleIntervalMs);
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
	 * Signal every process of the run, then confirm they are gone.
	 *
	 * The targets are every process tracked for this run by birth identity: the
	 * process group while it is ours, descendants that left it (`setsid`), and
	 * members whose leader or parent has already exited. That is the set the
	 * sampler measures and machine protection chooses by. A member the SIGTERM
	 * orphans still gets the SIGKILL, and a reused PID never does.
	 *
	 * The run is `stopped` only once none of its processes remain. Until then it
	 * stays `running` with its stop reason, keeps being watched, and is finished
	 * as stopped when the last process goes; a repeated stop signals again.
	 * Either way it is no longer a candidate for machine protection, which moves
	 * on to the next largest process. Repeating a stop of a stopped run is a
	 * no-op rather than an error, because an agent that stopped a trial and asks
	 * again should be told the same thing it was told the first time.
	 */
	async stop(id: string, reason: string, observations: string[] = []): Promise<ExperimentView> {
		const entry = this.require(id);
		if (entry.status !== "running") return this.view(entry);
		entry.stopReason ??= reason;
		entry.unregister?.();
		entry.unregister = undefined;
		this.persist(entry);
		this.options.record?.("experiment_stop_requested", {
			experiment_id: id, reason, observations,
			elapsed_seconds: (Date.now() - entry.startedAt) / 1000,
			lines_emitted: entry.lines,
		});
		entry.stopping ??= this.terminate(entry).finally(() => { entry.stopping = undefined; });
		await entry.stopping;
		this.finish(entry);
		if (!entry.finished) {
			this.options.record?.("experiment_stop_incomplete", {
				experiment_id: id, reason: entry.stopReason,
				remaining: [...entry.members.values()].map((member) => member.pid),
			});
		}
		return this.view(entry);
	}

	/** SIGTERM, a grace period, SIGKILL to whatever remains, and a bounded wait for it to go. */
	private async terminate(entry: Live): Promise<void> {
		const gone = async () => {
			const deadline = Date.now() + this.limits.stopGraceMs;
			while (Date.now() < deadline) {
				if (!this.running(entry, 0)) return true;
				await new Promise((settle) => setTimeout(settle, Math.min(25, this.limits.stopGraceMs)));
			}
			return !this.running(entry, 0);
		};
		const targets = this.stopTargets(entry);
		this.signalTree(entry, targets, "SIGTERM");
		if (await gone()) return;
		if (entry.record.launcher) {
			// The launcher ignores SIGTERM and is killed last: while it lives, a process
			// forked during the stop re-parents to it and the next round finds it. It
			// exits by itself once nothing of its tree remains.
			const deadline = Date.now() + this.limits.stopGraceMs;
			while (Date.now() < deadline) {
				const rest = this.stopTargets(entry).filter((target) => !this.isLauncher(entry, target));
				if (!rest.length) break;
				this.signalTree(entry, rest, "SIGKILL", false);
				await new Promise((settle) => setTimeout(settle, Math.min(25, this.limits.stopGraceMs)));
			}
			if (await gone()) return;
		}
		this.signalTree(entry, [...targets, ...this.stopTargets(entry)], "SIGKILL");
		await gone();
	}

	private isLauncher(entry: Live, target: ProcessIdentity): boolean {
		// The launcher leads the group it was spawned into, whichever PID a recovered record names.
		return !!entry.record.launcher && target.pid === entry.record.pgid;
	}

	/** The launcher's record of the command, cached once the command ended. */
	private commandStatus(entry: Live): CommandStatus | undefined {
		if (commandEnded(entry.command) || !entry.record.launcher) return entry.command;
		const status = readCommandStatus(join(entry.record.directory, COMMAND_STATUS_FILE));
		if (status) entry.command = status;
		return entry.command;
	}

	/**
	 * Whether the command itself has ended, apart from processes it left behind.
	 * A shell call returns then, as a shell does.
	 */
	commandExit(id: string): CommandExit {
		const entry = this.require(id);
		const status = this.commandStatus(entry);
		const ended = commandEnded(status) || entry.finished === true || entry.status !== "running";
		return { ended, ...(status?.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
			...(status?.signal ? { signal: status.signal } : {}) };
	}

	/**
	 * PIDs of the run's live processes from a fresh scan, without the launcher:
	 * what a command left running after it ended.
	 */
	remaining(id: string): number[] {
		const entry = this.require(id);
		if (entry.finished) return [];
		const scan = this.scan(entry, 0);
		if (scan) return scan.members.map((member) => member.pid).filter((pid) => !(entry.record.launcher && pid === entry.record.pgid));
		return liveGroup(entry.record.pgid).map((member) => member.pid).filter((pid) => pid !== entry.record.pid);
	}

	/**
	 * Log bytes from `cursor` on.
	 *
	 * Reading forward from a cursor is what lets observation resume across a
	 * model turn or a compaction without replaying the whole metric history into
	 * the model's context. The cursor stops before a character the cap would cut,
	 * so the next read starts on it and no byte is skipped. A cap below one
	 * character's widest encoding (four bytes) is refused: it could not return
	 * a whole character.
	 */
	output(id: string, cursor = 0, maxBytes = 8_192): { text: string; cursor: number; remaining: number } {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_OUTPUT_BYTES) {
			throw new RangeError(`maxBytes must be an integer of at least ${MIN_OUTPUT_BYTES}`);
		}
		const entry = this.require(id);
		const size = fileSize(entry.logFd);
		const from = Math.max(0, Math.min(cursor, size));
		const cap = Math.min(maxBytes, this.limits.outputCapBytes);
		const length = Math.min(cap, size - from);
		if (length <= 0) return { text: "", cursor: size, remaining: 0 };
		let buffer: Buffer;
		try { buffer = readRange(entry.logFd, from, length); }
		catch { return { text: "", cursor: from, remaining: size - from }; }
		let { text, bytes } = decodePrefix(buffer, cap);
		// Only a character still being written may wait for its remaining bytes.
		const finished = entry.status !== "running" || from + buffer.length < size;
		if (bytes === 0 && finished) {
			// A truncated character at the end of a finished log never completes:
			// it reads as one replacement character (three bytes, within any cap).
			text = "\uFFFD";
			bytes = buffer.length;
		}
		return { text, cursor: from + bytes, remaining: size - (from + bytes) };
	}

	/** The end of the log within `maxBytes`, for a blocking call's result. `logPath` is where the agent reads the full log. */
	tail(id: string, maxBytes: number): { text: string; omittedBytes: number; logPath: string } {
		const entry = this.require(id);
		return { ...readTail(entry.logFd, Math.min(maxBytes, this.limits.outputCapBytes)), logPath: this.view(entry).logPath };
	}

	/**
	 * The owner has what it needs from this run (a shell call's result): write
	 * the agent's copy now, and close the log once the run is finished (at once
	 * when it already is). A run still running is copied again when it ends.
	 */
	release(id: string): void {
		const entry = this.require(id);
		entry.released = true;
		this.spill(entry);
		if (entry.finished) this.closeLog(entry);
	}

	/** Stop everything still running. A detached process outliving the run is the failure mode. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.live.keys()].map((id) => this.stop(id, "supervisor closed").catch(() => undefined)));
		for (const entry of this.live.values()) if (entry.finished) this.closeLog(entry);
	}

	private spillPath(id: string): string | undefined {
		const spill = this.options.spill;
		return spill ? join(spill.directory, `${id}.log`) : undefined;
	}

	/** Copy the log, from the harness's descriptor, to where the agent reads it. Failures are recorded, never thrown. */
	private spill(entry: Live): void {
		const spill = this.options.spill;
		if (!spill || entry.logFd === undefined) return;
		try { writeCopy(spill.base, spill.directory, `${entry.record.id}.log`, entry.logFd); }
		catch (error) {
			this.options.record?.("experiment_spill_failed", { experiment_id: entry.record.id,
				error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
		}
	}

	private closeLog(entry: Live): void {
		if (entry.logFd === undefined) return;
		try { closeSync(entry.logFd); } catch { /* already closed */ }
		entry.logFd = undefined;
	}

	/** Reattach logs, liveness polling and control without spawning anything. */
	attach(record: ExperimentRecord, state: AttachState): ExperimentView {
		if (this.live.has(record.id)) return this.status(record.id);
		const startedAt = Date.parse(record.startedAt);
		// What the earlier supervisor learned: reported kinds, output calibration and tracked members.
		// Malformed state is treated as absent and recorded; it never stops the reattach.
		const statePath = join(record.directory, "supervisor-state.json");
		const malformed: string[] = [];
		let persisted: { gate?: Partial<GateState>; members?: ProcessIdentity[] } = {};
		if (present(statePath)) {
			// Never through a symlink: a replaced state file counts as malformed.
			const value = readRecordJson(statePath);
			if (value === undefined) malformed.push("supervisor-state.json");
			else {
				const restored = restoredState(value);
				persisted = restored.state;
				malformed.push(...restored.malformed.map((field) => `supervisor-state.json:${field}`));
			}
		}
		const given = restoredState({ gate: state.gate, members: state.members });
		malformed.push(...given.malformed.map((field) => `caller:${field}`));
		// The log, opened once like a started run's. A symlink there is refused: the run reattaches without output.
		let logFd: number | undefined;
		try { logFd = openLog(record.logPath); } catch { malformed.push("output.log"); }
		if (malformed.length) this.options.record?.("experiment_state_malformed", { experiment_id: record.id, fields: malformed });
		const gate = this.gate(startedAt, record.expectedGapMs);
		gate.restore(given.state.gate ?? persisted.gate);
		const members = given.state.members ?? persisted.members ?? [];
		const entry: Live = { record, identity: state.identity, startedAt, status: state.status ?? "running",
			stopReason: state.stopReason, logBytes: state.cursor ?? 0, lines: state.lines ?? 0, pending: [], recent: [],
			gate, lastLineAt: gate.lastOutputAt,
			members: new Map(members.map((member) => [memberKey(member), member])),
			// The group is verifiably ours only while its recorded leader is alive.
			groupHeld: ownedProcessAlive(state.identity), logFd, spillPath: this.spillPath(record.id) };
		this.live.set(record.id, entry);
		if (entry.status === "running") {
			this.protect(entry);
			entry.timer = setInterval(() => this.safeTick(entry), this.limits.sampleIntervalMs);
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

	/**
	 * The run's live processes from one `/proc` scan, updating what is tracked.
	 * Undefined where membership cannot be scanned (Darwin, or `/proc` failing);
	 * callers then fall back to the process group.
	 */
	private scan(entry: Live, maxAgeMs = SNAPSHOT_REUSE_MS): Scan | undefined {
		if (process.platform !== "linux") return undefined;
		let snapshot: ReturnType<typeof processSnapshot>;
		try { snapshot = processSnapshot("/proc", maxAgeMs); } catch { return undefined; }
		const found = ownedMembers(entry.record.pgid, snapshot.processes, entry.members.values(), entry.groupHeld);
		entry.groupHeld = found.groupHeld;
		const tracked = new Map(found.tracked.map((member) => [memberKey(member), member]));
		const joined = [...tracked.keys()].some((key) => !entry.members.has(key));
		entry.members = tracked;
		// A process that joined is persisted at once: after a restart it is still ours.
		if (joined && !entry.finished) this.persist(entry);
		const pgid = entry.record.pgid;
		return { at: snapshot.at, members: found.members, groupAlive: pgid > 0 && snapshot.processes.some((p) => p.pgid === pgid) };
	}

	/** Whether any process of the run lives. `maxAgeMs: 0` for decisions that must not act on a reading from before a signal. */
	private running(entry: Live, maxAgeMs?: number, scan = this.scan(entry, maxAgeMs)): boolean {
		// A group with live processes that are no longer verifiably ours (a recovered run
		// whose leader exited) still blocks finishing, but is never signalled.
		if (scan) return scan.members.length > 0 || scan.groupAlive;
		if (process.platform === "darwin") return ownedProcessAlive(entry.identity) || liveGroup(entry.record.pgid).length > 0;
		return ownedProcessAlive(entry.identity) || groupRunning(entry.record.pgid, maxAgeMs);
	}

	/** One reading over the run's processes; CPU is a rate since `previous`. */
	private measure(entry: Live, scan: Scan | undefined, previous?: ResourceSample): ResourceSample | null {
		if (scan) return sampleProcesses(scan.members, scan.at, previous);
		return sampleGroup(entry.record.pgid, previous);
	}

	/**
	 * Every live process of the run from a fresh scan, each confirmed against a
	 * fresh read of its PID: a PID whose birth changed since the scan is dropped.
	 */
	private stopTargets(entry: Live): ProcessIdentity[] {
		const scan = this.scan(entry, 0);
		return scan ? confirmedTargets(scan.members) : [];
	}

	private signalTree(entry: Live, targets: ProcessIdentity[], signal: NodeJS.Signals, group = true): void {
		const kill = this.options.kill ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
		// The group as a whole, while a verified member still holds its ID: a group
		// ID is not reused while any process carries it. This also reaches members
		// born after the scan.
		const pgid = entry.record.pgid;
		const held = group && pgid > 0 && (ownedProcessAlive(entry.identity)
			|| targets.some((target) => target.pgid === pgid && ownedProcessAlive(target)));
		if (held) {
			try { kill(-pgid, signal); } catch { /* already gone */ }
		}
		for (const target of targets) {
			// Checked again at the moment of signalling: never signal a reused PID.
			if (!sameProcessAlive(target)) continue;
			try { kill(target.pid, signal); } catch { /* already gone */ }
		}
	}

	private persist(entry: Live): void {
		atomicJson(join(entry.record.directory, "supervisor-state.json"), {
			schemaVersion: 1, status: entry.status, stopReason: entry.stopReason, identity: entry.identity,
			cursor: entry.logBytes, lines: entry.lines, exitCode: entry.exitCode,
			gate: entry.gate.snapshot(), members: [...entry.members.values()],
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
		const size = fileSize(entry.logFd);
		if (size <= entry.logBytes) return false;
		let buffer: Buffer;
		try { buffer = readRange(entry.logFd, entry.logBytes, Math.min(size - entry.logBytes, 65536)); }
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
			if (entry.logFd !== undefined) writeSync(entry.logFd, encoded);
		} catch {
			// A log write that fails must not stop ingestion or kill the fit.
		}
	}

	private protect(entry: Live): void {
		const work: ProtectedWork = { rssBytes: 0, peakBytes: 0, largestProcessBytes: 0,
			refresh: () => {
				// The shared scan of this tick: tracked members, not only the group. Memory
				// only, so the CPU rate of the run's own sample is left alone.
				this.account(entry, this.measure(entry, this.scan(entry)));
			},
			stop: async (peak, machine) => {
				// The owner hears its memory warning no later than the stop, from the same
				// reading, even when another owner's tick made the decision before this one sampled.
				this.resample(entry, this.scan(entry));
				this.evaluate(entry, machine);
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

	/** The run's own sample, its CPU a rate since the previous one. A reading of the same scan keeps the previous rate. */
	private resample(entry: Live, scan: Scan | undefined): ResourceSample | null {
		const previous = entry.sample;
		const sample = this.measure(entry, scan, previous);
		if (!sample) return null;
		if (previous && sample.at - previous.at < 1) sample.cpuPercent = previous.cpuPercent;
		entry.sample = sample;
		return sample;
	}

	/** What machine protection chooses by: the run's memory now and at its peak. */
	private account(entry: Live, sample: ResourceSample | null | undefined): void {
		const work = entry.protectedWork;
		if (!work) return;
		if (!sample) { work.rssBytes = 0; work.largestProcessBytes = 0; return; }
		work.rssBytes = sample.rssBytes;
		work.peakBytes = Math.max(work.peakBytes, work.rssBytes);
		work.largestProcessBytes = sample.largestProcessBytes ?? sample.rssBytes;
	}

	/**
	 * A tick from the timer. A failure (the run's directory removed, a disk
	 * full) is recorded once and never thrown out of the timer, where it would
	 * end the harness process; the next tick tries again.
	 */
	private readonly tickFailures = new WeakSet<Live>();
	private safeTick(entry: Live): void {
		try { this.tick(entry); }
		catch (error) {
			if (this.tickFailures.has(entry)) return;
			this.tickFailures.add(entry);
			this.options.record?.("experiment_tick_failed", { experiment_id: entry.record.id,
				error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * One tick: one `/proc` scan for liveness, the sample and the protection
	 * refresh, and one machine reading for the warning and the protection check.
	 * Warnings are evaluated before protection acts on the same reading.
	 */
	private tick(entry: Live): void {
		this.tailLog(entry);
		const scan = this.scan(entry);
		if (!entry.finished && !this.running(entry, undefined, scan)) {
			this.finish(entry);
			return;
		}
		let machine: MachineSample | undefined;
		if (entry.status === "running") {
			this.account(entry, this.resample(entry, scan));
			try { machine = this.protection.machine(); } catch { machine = undefined; }
		}
		this.evaluate(entry, machine);
		if (machine && entry.status === "running") void this.protection.check(Date.now(), machine).catch(() => undefined);
	}

	/** Every finding due now, each kind once, in the gate's order. */
	private evaluate(entry: Live, machine?: MachineSample): void {
		for (let round = 0; round < 16 && this.decide(entry, machine); round++);
	}

	private decide(entry: Live, machine?: MachineSample): boolean {
		const update = entry.gate.decide({
			now: Date.now(), view: this.view(entry), sample: entry.sample,
			pending: entry.pending, recent: entry.recent, exited: entry.status !== "running",
			projectedDurationMs: entry.record.projectedDurationMs, outputBytes: fileSize(entry.logFd),
			...(machine ? { machine: { availableBytes: machine.availableBytes, reserveBytes: this.protection.reserveBytes } } : {}),
		});
		entry.pending = [];
		if (!update) return false;
		let prompt: PromptReference | undefined;
		const promptId = update.notePrompt ?? NOTE_PROMPTS[update.kind];
		if (promptId && update.facts) {
			const rendered = this.notes.render(promptId, update.facts as never);
			update.note = rendered.text;
			prompt = rendered.reference;
		}
		// Reported kinds survive a restart of the harness.
		this.persist(entry);
		this.options.record?.("experiment_update", {
			experiment_id: entry.record.id, kind: update.kind, note: update.note, facts: update.facts, prompt,
			elapsed_seconds: update.view.elapsedSeconds, cpu_percent: update.view.cpuPercent,
			rss_mb: update.view.rssMb, lines_emitted: update.view.linesEmitted,
			stall_threshold_ms: entry.gate.stallThresholdMs(),
		});
		void Promise.resolve(this.options.deliver(renderUpdate(update), update)).catch(() => undefined);
		return true;
	}

	private finish(entry: Live): void {
		if (entry.finished) return;
		if (this.running(entry, 0)) return;
		this.tailLog(entry, true);
		entry.unregister?.();
		entry.unregister = undefined;
		if (entry.timer) {
			clearInterval(entry.timer);
			entry.timer = undefined;
		}
		// The tree can be gone before the launcher's exit event arrives; its status file already has the command's exit.
		if (entry.exitCode === undefined && entry.status === "running" && entry.record.launcher) {
			const command = this.commandStatus(entry);
			entry.exitCode = command?.exitCode ?? (command?.signal ? -1 : undefined);
		}
		// A requested stop is complete only now that no process of the run remains.
		if (entry.status === "running") entry.status = entry.stopReason ? "stopped" : "exited";
		entry.endedAt ??= Date.now();
		// One last pass so the exit itself, and whatever it printed on the way
		// out, still reach the agent.
		entry.finished = true;
		this.persist(entry);
		this.evaluate(entry);
		// A released run (its call already returned) gets its final copy; nothing reads the log after that.
		if (entry.released) this.spill(entry);
		if (entry.released || this.closed) this.closeLog(entry);
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
			...(entry.protectedWork?.peakBytes ? { peakRssMb: entry.protectedWork.peakBytes / 1024 ** 2 } : {}),
			processes: entry.sample?.processes,
			stalled: entry.status === "running"
				&& entry.gate.silenceMs(now) >= entry.gate.stallThresholdMs()
				&& (entry.sample?.cpuPercent ?? 100) < this.limits.idleCpuPercent,
			// Where the agent reads the full log: its copy when there is one, never the harness's log otherwise.
			logPath: entry.spillPath ?? entry.record.logPath,
		};
	}
}
