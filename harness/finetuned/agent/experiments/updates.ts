/**
 * When to wake the agent, and how often.
 *
 * Sampling is free and never spends a turn. A wake is a model call, billed in
 * tokens, so it comes from a rule over the samples rather than from a timer.
 * `SGDClassifier(verbose=1)` emits 152 lines in 2.9 s -- 52 a second -- and one
 * wake per line is unaffordable in both context and money.
 *
 * The stall rule is deliberately not a constant. The longest legitimate silence
 * measured 6.2 s on one corpus and 35.7 s on 5.5x the text: a threshold tuned on
 * the first fires constantly on the second, and one tuned on the second sleeps
 * through a real hang on the first. The threshold is derived from the pilot's
 * measured gap, or failing that from the gaps this run has already shown.
 */

import { DIAGNOSTIC_PATTERN, type ExperimentView, type ResourceSample, type SupervisorLimits, type Update, type UpdateKind } from "./types.js";

export interface GateInput {
	now: number;
	view: ExperimentView;
	sample?: ResourceSample;
	/** Lines drained since the last update, oldest first. */
	pending: string[];
	/** Set once the process group is gone. */
	exited?: boolean;
}

export class UpdateGate {
	private observedMaxGap = 0;
	private lastLineAt: number | undefined;
	private lastUpdateAt = 0;
	private stallReported = false;
	private memoryReported = false;
	private exitReported = false;

	constructor(
		private readonly limits: SupervisorLimits,
		private readonly startedAt: number,
		/** Longest silence an earlier pilot measured for a fit of this shape. */
		private readonly expectedGapMs?: number,
		/** Resident bytes worth interrupting for. A grid search reached 5.8 GB. */
		private readonly memoryCeilingBytes?: number,
	) {}

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
		}
		this.lastLineAt = at;
		this.stallReported = false;
	}

	/** Silence past this, at idle CPU, is a stall. Derived, never fixed. */
	stallThresholdMs(): number {
		const basis = this.expectedGapMs ?? this.observedMaxGap;
		return Math.max(this.limits.minStallMs, basis * this.limits.stallGapMultiple);
	}

	silenceMs(now: number): number {
		return now - (this.lastLineAt ?? this.startedAt);
	}

	decide(input: GateInput): Update | null {
		const { now, pending } = input;
		const emit = (kind: UpdateKind, note?: string): Update => {
			this.lastUpdateAt = now;
			return {
				kind, id: input.view.id, at: now, view: input.view,
				lines: pending.slice(-this.limits.linesPerUpdate),
				...(note ? { note } : {}),
			};
		};

		// Exit, diagnostics, and stalls jump the queue: they are the cases where
		// the agent's next decision changes.
		if (input.exited && !this.exitReported) {
			this.exitReported = true;
			return emit("exited", `the process group is gone with exit code ${input.view.exitCode ?? "unknown"}`);
		}
		const diagnostic = pending.find((line) => DIAGNOSTIC_PATTERN.test(line));
		if (diagnostic) return emit("diagnostic", "the trial's own output matched an error or warning pattern");

		if (this.memoryCeilingBytes && input.sample && !this.memoryReported
			&& input.sample.rssBytes >= this.memoryCeilingBytes) {
			this.memoryReported = true;
			return emit("memory", `resident memory reached ${(input.sample.rssBytes / 1024 ** 3).toFixed(1)} GB across ${input.sample.processes} process(es)`);
		}

		if (this.isStalled(input)) {
			this.stallReported = true;
			return emit("stalled",
				`no output for ${(this.silenceMs(now) / 1000).toFixed(1)} s at ${input.sample?.cpuPercent?.toFixed(0) ?? "unknown"}% CPU, `
				+ `past the ${(this.stallThresholdMs() / 1000).toFixed(1)} s threshold derived for this trial`);
		}

		// Routine progress. Healthy CPU with output still flowing is not news, so
		// it produces at most one coalesced update per interval.
		if (pending.length === 0) return null;
		if (now - this.lastUpdateAt < this.limits.updateIntervalMs) return null;
		return emit("progress");
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
		if (this.stallReported || input.exited) return false;
		if (input.now - this.startedAt < this.limits.importPreludeMs) return false;
		if (this.silenceMs(input.now) < this.stallThresholdMs()) return false;
		const cpu = input.sample?.cpuPercent;
		return cpu !== undefined && cpu < this.limits.idleCpuPercent;
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
