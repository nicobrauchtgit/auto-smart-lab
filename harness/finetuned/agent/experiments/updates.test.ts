import { describe, expect, test } from "bun:test";

import { UpdateGate, renderUpdate } from "./updates.js";
import { DEFAULT_LIMITS, type ExperimentView, type ResourceSample, type SupervisorLimits } from "./types.js";

const START = 1_000_000;

const limits = (overrides: Partial<SupervisorLimits> = {}): SupervisorLimits => ({ ...DEFAULT_LIMITS, ...overrides });

const view = (overrides: Partial<ExperimentView> = {}): ExperimentView => ({
	id: "ab12cd34", status: "running", scope: "one fold on 2,000 rows", hypothesis: "char n-grams help",
	elapsedSeconds: 30, linesEmitted: 12, cursor: 400, logPath: "/tmp/experiments/ab12cd34/output.log",
	...overrides,
});

const sample = (cpuPercent: number, rssBytes = 500 * 1024 ** 2): ResourceSample =>
	({ at: START, processes: 1, cpuSeconds: 1, rssBytes, cpuPercent });

describe("the stall threshold", () => {
	test("comes from the pilot's measured gap rather than a constant", () => {
		const small = new UpdateGate(limits(), START, { expectedGapMs: 6_200 });
		const large = new UpdateGate(limits(), START, { expectedGapMs: 35_700 });
		expect(small.stallThresholdMs()).toBe(6_200 * 4);
		expect(large.stallThresholdMs()).toBe(35_700 * 4);
	});

	test("scales itself from the gaps this run shows when no pilot supplied one", () => {
		const gate = new UpdateGate(limits(), START);
		gate.observeLine(START + 2_000);
		gate.observeLine(START + 8_200); // a 6.2 s legitimate gap
		expect(gate.stallThresholdMs()).toBe(6_200 * 4);
	});

	test("ignores the import prelude when calibrating", () => {
		// The first gap is scikit-learn importing, 1.6 to 1.9 s and silent by
		// nature. Counting it would let it set the threshold for the whole run.
		const gate = new UpdateGate(limits(), START);
		gate.observeLine(START + 1_900);
		expect(gate.stallThresholdMs()).toBe(DEFAULT_LIMITS.minStallMs);
	});

	test("neither corpus reports a false stall at its own longest legitimate silence", () => {
		for (const [gap, silence] of [[6_200, 6_200], [35_700, 35_700]] as const) {
			const gate = new UpdateGate(limits(), START, { expectedGapMs: gap });
			gate.observeLine(START + 20_000);
			const now = START + 20_000 + silence;
			expect(gate.decide({ now, view: view(), sample: sample(0), pending: [] })).toBeNull();
		}
	});

	test("a threshold tuned on the smaller corpus would have fired on the larger one", () => {
		// The measured 5.8x difference, and the reason a constant cannot serve both.
		const tunedSmall = new UpdateGate(limits(), START, { expectedGapMs: 6_200 });
		tunedSmall.observeLine(START + 20_000);
		const update = tunedSmall.decide({ now: START + 20_000 + 35_700, view: view(), sample: sample(0), pending: [] });
		expect(update?.kind).toBe("stalled");
	});
});

describe("stuck detection", () => {
	const stalling = () => {
		const gate = new UpdateGate(limits(), START, { expectedGapMs: 5_000 });
		gate.observeLine(START + 20_000);
		return gate;
	};

	test("a fit alive at 0% CPU is reported", () => {
		const update = stalling().decide({ now: START + 60_000, view: view(), sample: sample(0), pending: [] });
		expect(update?.kind).toBe("stalled");
		expect(update?.facts?.cpuPercent).toBe("0");
	});

	test("a silent fit pegged near 100% CPU is not", () => {
		// CPU proves liveness, not usefulness. Only the loss or validation series
		// rules out waste, and that is the other layer.
		expect(stalling().decide({ now: START + 60_000, view: view(), sample: sample(104), pending: [] })).toBeNull();
	});

	test("a healthy trial fitting one fold silently for over 15 s causes no wake", () => {
		// The trial worker prints only fold_started and fold_completed.
		const gate = new UpdateGate(limits(), START);
		gate.observeLine(START + 3_000); // fold_started
		for (let now = START + 3_250; now <= START + 120_000; now += 250) {
			expect(gate.decide({ now, view: view(), sample: sample(100), pending: [] })).toBeNull();
		}
		// Folds of 40 s each: a rhythm, and every fold inside it, is still healthy.
		const folds = new UpdateGate(limits(), START);
		for (let fold = 0; fold < 4; fold++) {
			folds.observeLine(START + 3_000 + fold * 40_000);
			folds.observeLine(START + 3_000 + fold * 40_000 + 39_900);
		}
		expect(folds.decide({ now: START + 3_000 + 4 * 40_000 + 60_000, view: view(), sample: sample(100), pending: [] })).toBeNull();
	});

	test("a start-up burst followed by a long silent fit is not a rhythm", () => {
		const gate = new UpdateGate(limits(), START);
		for (const at of [1_000, 1_100, 1_200, 1_300, 1_400]) gate.observeLine(START + at);
		expect(gate.decide({ now: START + 300_000, view: view(), sample: sample(100), pending: [] })).toBeNull();
	});

	test("busy silence far off the run's own sustained rhythm is reported stale once", () => {
		// An epoch line every 2 s for 30 s, then nothing for 4x the longest gap at full CPU.
		const gate = new UpdateGate(limits(), START);
		for (let at = 2_000; at <= 32_000; at += 2_000) gate.observeLine(START + at);
		expect(gate.decide({ now: START + 32_000 + 14_000, view: view(), sample: sample(100), pending: [] })).toBeNull();
		const update = gate.decide({ now: START + 32_000 + 15_000, view: view(), sample: sample(100), pending: [] });
		expect(update?.kind).toBe("stale");
		expect(update?.facts).toMatchObject({ gapSeconds: "2.0", cpuPercent: "100" });
		expect(gate.decide({ now: START + 32_000 + 60_000, view: view(), sample: sample(100), pending: [] })).toBeNull();
	});

	test("the import prelude is silent by nature and never reports", () => {
		const gate = new UpdateGate(limits({ minStallMs: 1_000 }), START, { expectedGapMs: 200 });
		expect(gate.decide({ now: START + 8_600, view: view(), sample: sample(0), pending: [] })).toBeNull();
		expect(gate.decide({ now: START + 20_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
	});

	test("a stall is reported once even after more output", () => {
		const gate = stalling();
		expect(gate.decide({ now: START + 60_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
		expect(gate.decide({ now: START + 70_000, view: view(), sample: sample(0), pending: [] })).toBeNull();
		gate.observeLine(START + 80_000);
		expect(gate.decide({ now: START + 140_000, view: view(), sample: sample(0), pending: [] })).toBeNull();
	});

	test("sampling being unavailable never turns into a stall report", () => {
		expect(stalling().decide({ now: START + 60_000, view: view(), pending: [] })).toBeNull();
	});
});

describe("the coalescer", () => {
	test("bounds the wake rate far below the line rate", () => {
		// SGDClassifier(verbose=1) emits 152 lines in 2.9 s, about 52 a second.
		const gate = new UpdateGate(limits(), START, { expectedGapMs: 5_000 });
		let wakes = 0;
		let pending: string[] = [];
		for (let line = 0; line < 152; line++) {
			const now = START + Math.round(line * 2_900 / 152);
			gate.observeLine(now);
			pending.push(`-- Epoch ${line}`);
			const update = gate.decide({ now, view: view(), sample: sample(98), pending });
			if (update) { wakes++; pending = []; }
		}
		expect(wakes).toBeLessThanOrEqual(1);
		expect(wakes * 20).toBeLessThan(152);
	});

	test("carries the delta and the last few lines, not the whole tail", () => {
		const gate = new UpdateGate(limits({ linesPerUpdate: 3 }), START, { expectedGapMs: 5_000 });
		const pending = Array.from({ length: 40 }, (_, index) => `seen=${index}`);
		const update = gate.decide({ now: START + 1_000, view: view(), sample: sample(90), pending, exited: true });
		expect(update?.lines).toEqual(["seen=37", "seen=38", "seen=39"]);
	});

	test("healthy CPU with no new output produces no wake at all", () => {
		const gate = new UpdateGate(limits(), START, { expectedGapMs: 5_000 });
		gate.observeLine(START + 1_000);
		expect(gate.decide({ now: START + 2_000, view: view(), sample: sample(97), pending: [] })).toBeNull();
	});
});

describe("what jumps the queue", () => {
	const gate = () => new UpdateGate(limits(), START, { expectedGapMs: 5_000 });

	test("a traceback does not wait for the progress interval", () => {
		const update = gate().decide({
			now: START + 100, view: view(), sample: sample(90),
			pending: ["Traceback (most recent call last):"],
		});
		expect(update?.kind).toBe("diagnostic");
	});

	test("a convergence warning is a diagnostic, not routine progress", () => {
		const update = gate().decide({
			now: START + 100, view: view(), sample: sample(90),
			pending: ["ConvergenceWarning: lbfgs failed to converge"],
		});
		expect(update?.kind).toBe("diagnostic");
	});

	test("exit is reported once, with the code", () => {
		const one = gate();
		const exited = { now: START + 100, view: view({ status: "exited", exitCode: 0 }), pending: [], exited: true };
		expect(one.decide(exited)?.kind).toBe("exited");
		expect(one.decide(exited)).toBeNull();
	});

	test("memory reaching the ceiling is reported once", () => {
		// gridsearch_parallel reached 5.8 GB across four workers.
		const one = new UpdateGate(limits(), START, { expectedGapMs: 5_000, memoryCeilingBytes: 5 * 1024 ** 3 });
		const input = { now: START + 100, view: view(), sample: sample(310, 5.8 * 1024 ** 3), pending: [] };
		expect(one.decide(input)?.kind).toBe("memory");
		expect(one.decide(input)).toBeNull();
	});
});

test("an update reads as measurements and points at the full log", () => {
	const gate = new UpdateGate(limits(), START, { expectedGapMs: 5_000 });
	const update = gate.decide({
		now: START + 1_000,
		view: view({ cpuPercent: 310, rssMb: 5_782, processes: 5 }),
		exited: true, sample: sample(310), pending: ["epoch 2/8 train_loss=0.1020 val_bacc=0.9841"],
	})!;
	const text = renderUpdate(update);
	expect(text).toContain("cpu 310%");
	expect(text).toContain("rss 5782 MB");
	expect(text).toContain("scope: one fold on 2,000 rows");
	expect(text).toContain("train_loss=0.1020");
	expect(text).toContain("output.log");
});

describe("reports keep the run's last lines", () => {
	test("an exit after quiet ticks still carries the lines the run ended with", () => {
		const gate = new UpdateGate(limits({ linesPerUpdate: 2 }), START);
		const recent = ["fold 4 done", "Traceback (most recent call last): ValueError"];
		const update = gate.decide({ now: START + 5_000, view: view(), pending: [], recent, exited: true });
		expect(update?.kind).toBe("exited");
		expect(update?.lines).toEqual(recent);
	});
});

describe("runaway memory is measured against the protection reserve", () => {
	const GiB = 1024 ** 3;
	const reserve = DEFAULT_LIMITS.memoryReserveBytes;
	test("plenty of headroom above the reserve is no news, however large the process", () => {
		// Total RAM is irrelevant: a 4 GiB fit with 20 GiB still available is fine.
		const gate = new UpdateGate(limits(), START);
		expect(gate.decide({ now: START + 1_000, view: view(), sample: sample(100, 4 * GiB), pending: [],
			machine: { availableBytes: reserve + 20 * GiB, reserveBytes: reserve } })).toBeNull();
	});

	test("the warning fires while available RAM is still above the reserve, before protection stops anything", () => {
		const gate = new UpdateGate(limits(), START);
		let warnedAbove: number | undefined;
		// A process growing 256 MiB a sample while the machine's available RAM shrinks with it.
		for (let step = 0; step < 64; step++) {
			const rss = 512 * 1024 ** 2 + step * 256 * 1024 ** 2;
			const available = reserve + 8 * GiB - step * 256 * 1024 ** 2;
			if (available < reserve) break; // machine protection would stop it here
			const update = gate.decide({ now: START + step * 250, view: view(), sample: sample(100, rss), pending: [],
				machine: { availableBytes: available, reserveBytes: reserve } });
			if (update?.kind === "memory") { warnedAbove = available - reserve; expect(update.facts?.reserveMb).toBe("1024"); break; }
		}
		expect(warnedAbove).toBeGreaterThan(0);
	});
});

describe("time-wasting compares like with like", () => {
	test("a call much slower than a short projection is not reported before the minimum duration", () => {
		// Three `true` calls (~5 ms), then `sleep 1.2`: no report.
		const gate = new UpdateGate(limits(), START);
		expect(gate.decide({ now: START + 1_200, view: view(), sample: sample(0.5), pending: [], projectedDurationMs: 5 })).toBeNull();
	});

	test("ordinary mixes of quick and slower calls cause no report", () => {
		for (const [projected, elapsed] of [[5, 1_200], [2_000, 5_500], [30_000, 59_000], [40_000, 100_000]] as const) {
			const gate = new UpdateGate(limits(), START);
			expect(gate.decide({ now: START + elapsed, view: view(), sample: sample(100), pending: [], projectedDurationMs: projected })).toBeNull();
		}
	});

	test("far beyond comparable work and past the minimum duration is reported once", () => {
		const gate = new UpdateGate(limits(), START);
		const input = { now: START + 125_000, view: view(), sample: sample(100), pending: [], projectedDurationMs: 40_000 };
		const update = gate.decide(input);
		expect(update?.kind).toBe("time-wasting");
		expect(update?.facts).toEqual({ elapsedSeconds: "125.0", projectedSeconds: "40.0", multiple: "3" });
		expect(gate.decide(input)).toBeNull();
	});

	test("without a projection there is no verdict", () => {
		const gate = new UpdateGate(limits(), START);
		expect(gate.decide({ now: START + 3_600_000, view: view(), sample: sample(100), pending: [] })).toBeNull();
	});
});

describe("a blocking shell call", () => {
	test("delivers no exit, diagnostic or flooding update: the tool result is the answer", () => {
		const gate = new UpdateGate(limits(), START, { blocking: true });
		const noisy = { now: START + 500, view: view(), sample: sample(90), pending: ["Traceback (most recent call last):"],
			outputBytes: 10 * DEFAULT_LIMITS.outputCapBytes };
		expect(gate.decide(noisy)).toBeNull();
		expect(gate.decide({ ...noisy, exited: true })).toBeNull();
	});

	test("still reports a stall while it runs", () => {
		const gate = new UpdateGate(limits(), START, { blocking: true });
		expect(gate.decide({ now: START + 60_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
	});
});
