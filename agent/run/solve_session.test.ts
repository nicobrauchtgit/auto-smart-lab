import { describe, expect, test } from "bun:test";

import { decideIteration } from "./solve_session.js";
import type { IterationSignal } from "../solve/results.js";

function signal(overrides: Partial<IterationSignal> = {}): IterationSignal {
	return {
		ok: true,
		errors: [],
		reported: { mean_bacc: 0.98, done: false },
		recomputed: {
			mean_bacc: 0.98, pooled_bacc: 0.98, fold_low: 0.97, fold_high: 0.99,
			recall_0: 0.98, recall_1: 0.98,
			folds: [{ repeat: 0, fold: 0, n: 100, bacc: 0.98, recall_0: 0.98, recall_1: 0.98 }],
		},
		sealed: { n: 100, bacc: 0.975, gap: -0.005 },
		canary: { passed: true, reason: "unchanged", examples: 400 },
		paired: null,
		entrypoint: { module: "solutions/tasks/spam1.py", factory: "build_pipeline" },
		...overrides,
	};
}

const paired = (over: Record<string, unknown> = {}) => ({
	available: true, champion_bacc: 0.98, challenger_bacc: 0.982, delta: 0.002,
	low: -0.001, high: 0.005, clears_zero: false, corrected: 31, introduced: 27,
	folds_improved: 3, folds_total: 5, recall_0_delta: 0.001, recall_1_delta: 0.001,
	...over,
});

const base = { hasChampion: false, flatIterations: 0, iteration: 1, maxIterations: 6 };

describe("decideIteration", () => {
	test("the first measured iteration with a passing canary becomes the champion", () => {
		expect(decideIteration({ ...base, signal: signal() }).promote).toBe(true);
	});

	test("a failing canary never promotes, however good the score", () => {
		const decision = decideIteration({
			...base,
			signal: signal({
				recomputed: { ...signal().recomputed!, mean_bacc: 1.0 },
				canary: { passed: false, reason: "reads the id", examples: 400 },
			}),
		});
		expect(decision.promote).toBe(false);
	});

	test("a challenger whose delta does not clear its interval leaves the champion alone", () => {
		const decision = decideIteration({
			...base, hasChampion: true, signal: signal({ paired: paired() }),
		});
		expect(decision.promote).toBe(false);
		expect(decision.flatIterations).toBe(1);
	});

	test("a challenger whose delta clears its interval is promoted", () => {
		const decision = decideIteration({
			...base, hasChampion: true,
			signal: signal({ paired: paired({ clears_zero: true, delta: 0.01, low: 0.004, high: 0.016 }) }),
		});
		expect(decision.promote).toBe(true);
		expect(decision.flatIterations).toBe(0);
	});

	test("a significant regression does not promote even though it clears zero", () => {
		const decision = decideIteration({
			...base, hasChampion: true,
			signal: signal({ paired: paired({ clears_zero: true, delta: -0.01, low: -0.016, high: -0.004 }) }),
		});
		expect(decision.promote).toBe(false);
	});

	test("a cleared delta resets the no-progress streak", () => {
		const decision = decideIteration({
			...base, hasChampion: true, flatIterations: 1,
			signal: signal({ paired: paired({ clears_zero: true, delta: 0.01, low: 0.004, high: 0.016 }) }),
		});
		expect(decision.flatIterations).toBe(0);
		expect(decision.stop).toBeUndefined();
	});

	test("two consecutive flat iterations stop the loop", () => {
		const decision = decideIteration({
			...base, hasChampion: true, flatIterations: 1, signal: signal({ paired: paired() }),
		});
		expect(decision.flatIterations).toBe(2);
		expect(decision.stop).toBe("no_measurable_gain");
	});

	test("the agent can declare itself done", () => {
		const decision = decideIteration({
			...base, signal: signal({ reported: { mean_bacc: 0.98, done: true } }),
		});
		expect(decision.stop).toBe("agent_declared");
	});

	test("the budget stops the loop on the last iteration", () => {
		expect(decideIteration({ ...base, iteration: 6, signal: signal() }).stop).toBe("budget");
		expect(decideIteration({ ...base, iteration: 5, signal: signal() }).stop).toBeUndefined();
	});

	test("an unmeasurable iteration neither promotes nor counts as no progress", () => {
		const decision = decideIteration({
			...base, hasChampion: true, flatIterations: 1,
			signal: { ok: false, errors: ["metrics.json was not written"] },
		});
		expect(decision.promote).toBe(false);
		expect(decision.flatIterations).toBe(1);
		expect(decision.stop).toBeUndefined();
	});

	test("an unmeasurable final iteration still stops on budget", () => {
		const decision = decideIteration({
			...base, iteration: 6, signal: { ok: false, errors: ["metrics.json was not written"] },
		});
		expect(decision.stop).toBe("budget");
	});

	test("an unavailable champion comparison does not block the first promotion", () => {
		const decision = decideIteration({
			...base,
			signal: signal({ paired: { available: false, reason: "champion could not be re-run" } }),
		});
		expect(decision.promote).toBe(true);
	});
});
