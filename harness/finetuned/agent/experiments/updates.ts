/** Sampling never wakes a model. Only completion and once-per-kind findings do.
 * Silence thresholds scale from observed output gaps or an earlier measured gap.
 * The gate decides *whether* and *what kind*; the supervisor renders the note
 * from `agent/prompts/experiments/` so every agent-facing word is a prompt.
 */

import { DIAGNOSTIC_PATTERN, type ExperimentView, type ResourceSample, type SupervisorLimits, type Update, type UpdateKind } from "./types.js";

export interface GateInput {
	now: number;
	view: ExperimentView;
	sample?: ResourceSample;
	/** Lines drained since the last decision, oldest first. Matched for diagnostics. */
	pending: string[];
	/** The last few lines of the whole run, kept across decisions. Carried on reports. */
	recent?: string[];
	/** Set once the process group is gone. */
	exited?: boolean;
	outputBytes?: number;
	/** Wall time comparable work took before. Absent when nothing comparable was measured. */
	projectedDurationMs?: number;
	/** Machine memory as the machine-protection arbiter reads it. */
	machine?: { availableBytes: number; reserveBytes: number };
}

export interface GateOptions {
	/** Longest silence an earlier pilot measured for a fit of this shape. */
	expectedGapMs?: number;
	/** Resident bytes worth interrupting for. Overrides the reserve-relative warning. */
	memoryCeilingBytes?: number;
	/**
	 * The owner waits for this process inside one tool call. Its tool result is
	 * the answer, so exit, diagnostics and flooding are not reported on top of
	 * it; only findings during the call are.
	 */
	blocking?: boolean;
}

/** Output gaps needed before silence can be judged against the call's own rhythm. */
export const RHYTHM_GAPS = 3;

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(0);

export class UpdateGate {
	private observedMaxGap = 0;
	private gaps = 0;
	private firstLineAt: number | undefined;
	private lastLineAt: number | undefined;
	private readonly reported = new Set<UpdateKind>();
	private readonly options: GateOptions;

	constructor(
		private readonly limits: SupervisorLimits,
		private readonly startedAt: number,
		options: GateOptions = {},
	) {
		this.options = options;
	}

	/**
	 * Record that output arrived.
	 *
	 * The first gap is from the spawn to the first line, which is scikit-learn
	 * importing. Counting it would let a 1.9 s constant set the threshold for
	 * the whole run.
	 */
	observeLine(at: number): void {
		if (this.lastLineAt !== undefined) {
			this.observedMaxGap = Math.max(this.observedMaxGap, at - this.lastLineAt);
			this.gaps++;
		}
		this.firstLineAt ??= at;
		this.lastLineAt = at;
	}

	/** Silence past this, at idle CPU, is a stall. Derived, never fixed. */
	stallThresholdMs(): number {
		const basis = this.options.expectedGapMs ?? this.observedMaxGap;
		return Math.max(this.limits.minStallMs, basis * this.limits.stallGapMultiple);
	}

	silenceMs(now: number): number {
		return now - (this.lastLineAt ?? this.startedAt);
	}

	decide(input: GateInput): Update | null {
		const { now, pending } = input;
		const emit = (kind: UpdateKind, facts: Record<string, string>): Update => {
			this.reported.add(kind);
			return {
				kind, id: input.view.id, at: now, view: input.view, facts,
				lines: (input.recent ?? pending).slice(-this.limits.linesPerUpdate),
			};
		};
		const blocking = this.options.blocking === true;
		// A blocking call's tool result reports the exit; nothing is added after it.
		if (input.exited && blocking) return null;

		// Exit, diagnostics, and stalls jump the queue: they are the cases where
		// the agent's next decision changes.
		if (input.exited && !this.reported.has("exited")) {
			return emit("exited", { exitCode: String(input.view.exitCode ?? input.view.status) });
		}
		const diagnostic = pending.find((line) => DIAGNOSTIC_PATTERN.test(line));
		if (!blocking && diagnostic && !this.reported.has("diagnostic")) return emit("diagnostic", {});

		const memory = this.memoryPressure(input);
		if (memory) return emit("memory", memory);

		if (this.isStalled(input)) {
			return emit("stalled", {
				silenceSeconds: seconds(this.silenceMs(now)),
				cpuPercent: input.sample?.cpuPercent?.toFixed(0) ?? "unknown",
				thresholdSeconds: seconds(this.stallThresholdMs()),
			});
		}
		if (this.isStale(input)) {
			return emit("stale", {
				silenceSeconds: seconds(this.silenceMs(now)),
				cpuPercent: input.sample!.cpuPercent!.toFixed(0),
				gapSeconds: seconds(this.observedMaxGap),
				gaps: String(this.gaps),
			});
		}
		if (!blocking && input.outputBytes !== undefined && input.outputBytes > this.limits.outputCapBytes
			&& !this.reported.has("flooding")) {
			return emit("flooding", { capKiB: String(Math.round(this.limits.outputCapBytes / 1024)) });
		}
		const projected = input.projectedDurationMs;
		if (!input.exited && projected && projected > 0 && !this.reported.has("time-wasting")) {
			const elapsed = now - this.startedAt;
			if (elapsed >= Math.max(this.limits.overrunMinMs, projected * this.limits.overrunMultiple)) {
				return emit("time-wasting", {
					elapsedSeconds: seconds(elapsed), projectedSeconds: seconds(projected),
					multiple: String(this.limits.overrunMultiple),
				});
			}
		}
		return null;
	}

	/**
	 * Runaway memory, warned before machine protection acts.
	 *
	 * The arbiter stops the largest process once available RAM falls below the
	 * reserve. The warning fires while the headroom above that reserve is no
	 * larger than what this process already holds: growing by its own size again
	 * would trigger the stop. Since the headroom is still positive here, the
	 * warning always comes first for memory that grows between samples.
	 */
	private memoryPressure(input: GateInput): Record<string, string> | undefined {
		const sample = input.sample;
		if (!sample || input.exited || this.reported.has("memory") || sample.rssBytes <= 0) return undefined;
		const ceiling = this.options.memoryCeilingBytes;
		const machine = input.machine;
		const headroom = machine ? machine.availableBytes - machine.reserveBytes : undefined;
		const pressing = ceiling !== undefined ? sample.rssBytes >= ceiling
			: headroom !== undefined && headroom <= sample.rssBytes;
		if (!pressing) return undefined;
		return {
			rssMb: mib(sample.rssBytes), processes: String(sample.processes),
			headroomMb: headroom === undefined ? "unknown" : mib(Math.max(0, headroom)),
			reserveMb: machine ? mib(machine.reserveBytes) : "unknown",
		};
	}

	/**
	 * Silent, idle, and past both thresholds.
	 *
	 * CPU is what separates the two silences. A deliberately deadlocked trial sat
	 * at 0% through 89.5 s of it; every genuinely working configuration sat
	 * between 56% and 105%, and at 310% under `n_jobs=4`. A silent fit pegged on
	 * a core is working, and reporting it as stuck is the false alarm this rule
	 * exists to avoid.
	 */
	private isStalled(input: GateInput): boolean {
		if (this.reported.has("stalled") || input.exited) return false;
		if (input.now - this.startedAt < this.limits.importPreludeMs) return false;
		if (this.silenceMs(input.now) < this.stallThresholdMs()) return false;
		const cpu = input.sample?.cpuPercent;
		return cpu !== undefined && cpu < this.limits.idleCpuPercent;
	}

	/**
	 * Busy, silent, and off the rhythm this call set itself.
	 *
	 * Busy CPU with no output is what fitting looks like: a trial prints only
	 * when a fold starts and ends, so a fold can be silent for minutes. Silence
	 * alone is no evidence. It becomes evidence once the call has kept a rhythm
	 * -- at least RHYTHM_GAPS output gaps spread over at least the minimum stall
	 * time, an epoch or fold loop rather than a start-up burst -- and then stays
	 * silent for the stall multiple of its own longest gap.
	 */
	private isStale(input: GateInput): boolean {
		if (this.reported.has("stale") || input.exited) return false;
		const cpu = input.sample?.cpuPercent;
		if (cpu === undefined || cpu < this.limits.idleCpuPercent) return false;
		if (input.now - this.startedAt < this.limits.importPreludeMs) return false;
		if (this.gaps < RHYTHM_GAPS || this.firstLineAt === undefined || this.lastLineAt === undefined) return false;
		if (this.lastLineAt - this.firstLineAt < this.limits.minStallMs) return false;
		const silence = this.silenceMs(input.now);
		return silence >= this.stallThresholdMs() && silence >= this.observedMaxGap * this.limits.stallGapMultiple;
	}
}

/** The text one update delivers. Measurements, never instructions. */
export function renderUpdate(update: Update): string {
	const view = update.view;
	const head = `[experiment ${view.id}] ${update.kind}   ${view.elapsedSeconds.toFixed(1)} s elapsed   scope: ${view.scope}`;
	const resources = [
		view.cpuPercent !== undefined ? `cpu ${view.cpuPercent.toFixed(0)}%` : undefined,
		view.rssMb !== undefined ? `rss ${view.rssMb.toFixed(0)} MB` : undefined,
		view.processes !== undefined ? `${view.processes} process(es)` : undefined,
		`${view.linesEmitted} line(s) so far`,
	].filter(Boolean).join("   ");
	const lines = [head, `  ${resources}`];
	if (update.note) lines.push(`  ${update.note}`);
	if (update.lines.length) {
		lines.push("  last output:");
		for (const line of update.lines) lines.push(`    ${line.slice(0, 300)}`);
	}
	lines.push(`  full log: ${view.logPath}`);
	return lines.join("\n");
}
