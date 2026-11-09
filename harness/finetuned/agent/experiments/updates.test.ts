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
		const small = new UpdateGate(limits(), START, 6_200);
		const large = new UpdateGate(limits(), START, 35_700);
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
			const gate = new UpdateGate(limits(), START, gap);
			gate.observeLine(START + 20_000);
			const now = START + 20_000 + silence;
			expect(gate.decide({ now, view: view(), sample: sample(0), pending: [] })).toBeNull();
		}
	});

	test("a threshold tuned on the smaller corpus would have fired on the larger one", () => {
		// The measured 5.8x difference, and the reason a constant cannot serve both.
		const tunedSmall = new UpdateGate(limits(), START, 6_200);
		tunedSmall.observeLine(START + 20_000);
		const update = tunedSmall.decide({ now: START + 20_000 + 35_700, view: view(), sample: sample(0), pending: [] });
		expect(update?.kind).toBe("stalled");
	});
});

describe("stuck detection", () => {
	const stalling = () => {
		const gate = new UpdateGate(limits(), START, 5_000);
		gate.observeLine(START + 20_000);
		return gate;
	};

	test("a fit alive at 0% CPU is reported", () => {
		const update = stalling().decide({ now: START + 60_000, view: view(), sample: sample(0), pending: [] });
		expect(update?.kind).toBe("stalled");
		expect(update?.note).toContain("0% CPU");
	});

	test("a silent fit pegged near 100% CPU is not", () => {
		// CPU proves liveness, not usefulness. Only the loss or validation series
		// rules out waste, and that is the other layer.
		expect(stalling().decide({ now: START + 60_000, view: view(), sample: sample(104), pending: [] })).toBeNull();
	});

	test("the import prelude is silent by nature and never reports", () => {
		const gate = new UpdateGate(limits({ minStallMs: 1_000 }), START, 200);
		expect(gate.decide({ now: START + 8_600, view: view(), sample: sample(0), pending: [] })).toBeNull();
		expect(gate.decide({ now: START + 20_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
	});

	test("a stall is reported once, and again only after new output and new silence", () => {
		const gate = stalling();
		expect(gate.decide({ now: START + 60_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
		expect(gate.decide({ now: START + 70_000, view: view(), sample: sample(0), pending: [] })).toBeNull();
		gate.observeLine(START + 80_000);
		expect(gate.decide({ now: START + 140_000, view: view(), sample: sample(0), pending: [] })?.kind).toBe("stalled");
	});

	test("sampling being unavailable never turns into a stall report", () => {
		expect(stalling().decide({ now: START + 60_000, view: view(), pending: [] })).toBeNull();
	});
});

describe("the coalescer", () => {
	test("bounds the wake rate far below the line rate", () => {
		// SGDClassifier(verbose=1) emits 152 lines in 2.9 s, about 52 a second.
		const gate = new UpdateGate(limits(), START, 5_000);
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
		const gate = new UpdateGate(limits({ updateIntervalMs: 0, linesPerUpdate: 3 }), START, 5_000);
		const pending = Array.from({ length: 40 }, (_, index) => `seen=${index}`);
		const update = gate.decide({ now: START + 1_000, view: view(), sample: sample(90), pending });
		expect(update?.lines).toEqual(["seen=37", "seen=38", "seen=39"]);
	});

	test("healthy CPU with no new output produces no wake at all", () => {
		const gate = new UpdateGate(limits({ updateIntervalMs: 0 }), START, 5_000);
		gate.observeLine(START + 1_000);
		expect(gate.decide({ now: START + 2_000, view: view(), sample: sample(97), pending: [] })).toBeNull();
	});
});

describe("what jumps the queue", () => {
	const gate = () => new UpdateGate(limits(), START, 5_000);

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
		const one = new UpdateGate(limits(), START, 5_000, 5 * 1024 ** 3);
		const input = { now: START + 100, view: view(), sample: sample(310, 5.8 * 1024 ** 3), pending: [] };
		expect(one.decide(input)?.kind).toBe("memory");
		expect(one.decide(input)).toBeNull();
	});
});

test("an update reads as measurements and points at the full log", () => {
	const gate = new UpdateGate(limits({ updateIntervalMs: 0 }), START, 5_000);
	const update = gate.decide({
		now: START + 1_000,
		view: view({ cpuPercent: 310, rssMb: 5_782, processes: 5 }),
		sample: sample(310), pending: ["epoch 2/8 train_loss=0.1020 val_bacc=0.9841"],
	})!;
	const text = renderUpdate(update);
	expect(text).toContain("cpu 310%");
	expect(text).toContain("rss 5782 MB");
	expect(text).toContain("scope: one fold on 2,000 rows");
	expect(text).toContain("train_loss=0.1020");
	expect(text).toContain("output.log");
});
