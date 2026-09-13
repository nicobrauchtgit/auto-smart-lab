import { describe, expect, test } from "bun:test";

import { parseIterationSignal, renderIterationSignal, type IterationSignal } from "./results.js";

const measured = {
	mean_bacc: 0.984,
	pooled_bacc: 0.9838,
	fold_low: 0.9821,
	fold_high: 0.9863,
	recall_0: 0.9812,
	recall_1: 0.9868,
	folds: [{ repeat: 0, fold: 0, n: 3000, bacc: 0.983, recall_0: 0.98, recall_1: 0.986 }],
};

function signal(overrides: Record<string, unknown> = {}): IterationSignal {
	return parseIterationSignal({
		ok: true,
		errors: [],
		reported: { mean_bacc: 0.984, approach: "tfidf", variants_compared: 3, done: false },
		recomputed: measured,
		discrepancies: [],
		sealed: { n: 1666, bacc: 0.9798, gap: -0.0042 },
		canary: { passed: true, reason: "predicted probabilities unchanged when ids are neutralized", examples: 400, kind: "passed" },
		paired: null,
		...overrides,
	});
}

const view = { iteration: 2, maxIterations: 6, seed: 4021, revealSealed: false, isChampion: false };

describe("parseIterationSignal", () => {
	test("accepts a complete signal", () => {
		expect(signal().recomputed?.mean_bacc).toBe(0.984);
	});

	test("returns a failed signal without demanding measurements", () => {
		const failed = parseIterationSignal({ ok: false, errors: ["metrics.json was not written"] });
		expect(failed.ok).toBe(false);
		expect(failed.errors).toEqual(["metrics.json was not written"]);
	});

	test("rejects a signal that is not an object", () => {
		expect(() => parseIterationSignal("ok")).toThrow();
		expect(() => parseIterationSignal(null)).toThrow();
		expect(() => parseIterationSignal([])).toThrow();
	});

	test("rejects a successful signal with unusable numbers", () => {
		expect(() => signal({ recomputed: { ...measured, mean_bacc: "high" } })).toThrow(/mean_bacc/);
		expect(() => signal({ recomputed: { ...measured, fold_low: Number.NaN } })).toThrow(/fold_low/);
		expect(() => signal({ recomputed: { ...measured, folds: [] } })).toThrow(/folds/);
	});

	test("rejects a successful signal missing the sealed score or the canary", () => {
		expect(() => signal({ sealed: undefined })).toThrow(/sealed/);
		expect(() => signal({ canary: { passed: "yes", reason: "x", examples: 1 } })).toThrow(/canary/);
	});
});

describe("renderIterationSignal", () => {
	test("shows measured numbers and withholds the sealed score during the loop", () => {
		const text = renderIterationSignal(signal(), view);
		expect(text).toContain("mean BACC     0.9840");
		expect(text).toContain("folds 0.9821-0.9863");
		expect(text).toContain("canary        passed");
		expect(text).not.toContain("sealed split");
		expect(text).not.toContain("0.9798");
	});

	test("reveals the sealed score and the gap on the final iteration", () => {
		const text = renderIterationSignal(signal(), { ...view, revealSealed: true });
		expect(text).toContain("sealed split  0.9798");
		expect(text).toContain("dev-to-sealed gap -0.0042");
	});

	test("states plainly when a delta does not clear its interval", () => {
		const text = renderIterationSignal(signal({
			paired: {
				available: true, champion_bacc: 0.9821, challenger_bacc: 0.984, delta: 0.0019,
				low: -0.0004, high: 0.0041, clears_zero: false, corrected: 31, introduced: 27,
				folds_improved: 4, folds_total: 5, recall_0_delta: 0.0031, recall_1_delta: -0.0004,
			},
		}), view);
		expect(text).toContain("vs champion   +0.0019   [-0.0004, +0.0041]");
		expect(text).toContain("folds improved     4 / 5");
		expect(text).toContain("net 4 fewer errors");
		expect(text).toContain("does not clear its interval. Champion unchanged.");
	});

	test("net error wording distinguishes fewer from more", () => {
		const paired = {
			available: true, champion_bacc: 0.98, challenger_bacc: 0.98, delta: 0, low: -0.01, high: 0.01,
			clears_zero: false, folds_improved: 2, folds_total: 5, recall_0_delta: 0, recall_1_delta: 0,
		};
		expect(renderIterationSignal(signal({ paired: { ...paired, corrected: 10, introduced: 25 } }), view))
			.toContain("net 15 more errors");
		expect(renderIterationSignal(signal({ paired: { ...paired, corrected: 20, introduced: 20 } }), view))
			.toContain("no net change in errors");
	});

	test("announces a promotion when the delta clears its interval", () => {
		const text = renderIterationSignal(signal({
			paired: {
				available: true, champion_bacc: 0.95, challenger_bacc: 0.98, delta: 0.03,
				low: 0.01, high: 0.05, clears_zero: true, corrected: 90, introduced: 10,
				folds_improved: 5, folds_total: 5, recall_0_delta: 0.03, recall_1_delta: 0.03,
			},
		}), view);
		expect(text).toContain("This is the new champion.");
	});

	test("a failed canary overrides the promotion wording", () => {
		const text = renderIterationSignal(signal({
			canary: { passed: false, reason: "39 of 400 values changed when only the filename changed", examples: 400, kind: "id_dependence" },
			paired: {
				available: true, champion_bacc: 0.95, challenger_bacc: 1.0, delta: 0.05, low: 0.03,
				high: 0.07, clears_zero: true, corrected: 100, introduced: 0, folds_improved: 5,
				folds_total: 5, recall_0_delta: 0.05, recall_1_delta: 0.05,
			},
		}), view);
		expect(text).toContain("canary        FAILED");
		expect(text).toContain("do not describe a model that would work on the test set");
		expect(text).not.toContain("new champion");
	});

	test("surfaces a reported number that contradicts the predictions", () => {
		const text = renderIterationSignal(signal({
			discrepancies: [{ field: "mean_bacc", reported: 0.995, recomputed: 0.884 }],
		}), view);
		expect(text).toContain("you reported 0.995000, the predictions give 0.884000");
	});

	test("renders a failed measurement as the errors to fix", () => {
		const text = renderIterationSignal(
			parseIterationSignal({ ok: false, errors: ["metrics.json was not written"] }), view);
		expect(text).toContain("could not be measured");
		expect(text).toContain("metrics.json was not written");
		expect(text).toContain("No score was recorded for this iteration");
	});

	test("projects what a full cross-validation pass will cost", () => {
		const text = renderIterationSignal(signal({
			cost: {
				fit_seconds: 3.296, fit_rows: 400, seconds_per_1000_rows: 8.239,
				estimated_cv_seconds: 494.18, development_rows: 14995, folds: 5,
				session_seconds: 1800, share_of_session: 0.275,
			},
		}), view);
		expect(text).toContain("fit cost");
		expect(text).toContain("8.2 s per 1,000 rows");
		expect(text).toContain("8.2 min");
		expect(text).toContain("28% of one session");
	});

	test("states a cheap pass in seconds rather than minutes", () => {
		const text = renderIterationSignal(signal({
			cost: {
				fit_seconds: 0.199, fit_rows: 400, seconds_per_1000_rows: 0.497,
				estimated_cv_seconds: 29.794, development_rows: 14995, folds: 5,
				session_seconds: 1800, share_of_session: 0.017,
			},
		}), view);
		expect(text).toContain("~30 s for 5-fold");
		expect(text).not.toContain("min");
	});

	test("cost reaches the agent even when the iteration could not be measured", () => {
		const text = renderIterationSignal(parseIterationSignal({
			ok: false,
			errors: ["oof id(s) are not in the labels file"],
			canary: { passed: true, reason: "unchanged", examples: 400, kind: "passed", fit_seconds: 3.3 },
			cost: {
				fit_seconds: 3.3, fit_rows: 400, seconds_per_1000_rows: 8.2,
				estimated_cv_seconds: 494, development_rows: 14995, folds: 5,
				session_seconds: 1800, share_of_session: 0.275,
			},
		}), view);
		expect(text).toContain("could not be measured");
		expect(text).toContain("fit cost");
		expect(text).toContain("28% of one session");
	});

	test("a canary that could not run is not reported as leakage", () => {
		const text = renderIterationSignal(signal({
			canary: {
				passed: false, examples: 0, kind: "entrypoint_failed",
				reason: "could not load entrypoint: entrypoint module does not exist: solutions/tasks/spam1.py",
			},
		}), view);
		expect(text).toContain("could not load the entrypoint named in metrics.json");
		expect(text).not.toContain("do not describe a model that would work");
		expect(text).not.toContain("reads the id");
	});

	test("keeps the measurable diagnostics when compliance failed", () => {
		const text = renderIterationSignal(parseIterationSignal({
			ok: false,
			errors: ["14995 oof id(s) are not in the labels file, first aabxihdcdotgmase.0"],
			recomputed: measured,
			coverage: { scored: 1200, development_rows: 14995, complete: false },
			roc_auc: 0.91,
			canary: { passed: true, reason: "predicted probabilities unchanged", examples: 400, kind: "passed" },
		}), view);
		expect(text).toContain("could not be measured");
		expect(text).toContain("1200 of 14995 development rows");
		expect(text).toContain("mean BACC     0.9840");
		expect(text).toContain("ROC AUC       0.9100");
		expect(text).toContain("not comparable across iterations");
		expect(text).toContain("canary        passed");
	});

	test("an unmeasurable iteration still reports a canary failure it found", () => {
		const text = renderIterationSignal(parseIterationSignal({
			ok: false,
			errors: ["confirmation_predictions.csv must cover exactly the 1667 sealed ids"],
			canary: {
				passed: false, examples: 400, kind: "id_dependence",
				reason: "39 of 400 predicted probabilities changed when only the filename changed",
			},
		}), view);
		expect(text).toContain("canary        FAILED");
		expect(text).toContain("changes when only the filename changes");
	});

	test("explains an unavailable champion instead of hiding it", () => {
		const text = renderIterationSignal(
			signal({ paired: { available: false, reason: "champion could not be re-run: ImportError" } }), view);
		expect(text).toContain("vs champion   unavailable");
		expect(text).toContain("ImportError");
	});
});

describe("convergence", () => {
	const fullSize = {
		scope: "development_rows",
		rows: 14995,
		estimators: [{
			estimator: "SGDClassifier", path: "clf", step_unit: "epochs",
			configured: { max_iter: 1000 },
			controls: { early_stopping: false, tol: 0.001, n_iter_no_change: 5, warm_start: false },
			completed_iterations: 7, configured_iterations: 1000, reached_limit: false,
		}],
		convergence_warnings: [],
	};

	test("states completed work against the configured allowance", () => {
		const text = renderIterationSignal(signal({ convergence: fullSize }), view);
		// Never "iterations": that word already means a whole solve session here.
		expect(text).toContain("7 of 1000 epochs, stopped early");
		expect(text).not.toContain("of 1000 iterations");
		expect(text).toContain("14,995 development rows");
		expect(text).toContain("early_stopping=false");
	});

	test("says when a fit was cut off rather than finished", () => {
		const text = renderIterationSignal(signal({
			convergence: {
				...fullSize,
				estimators: [{ ...fullSize.estimators[0], completed_iterations: 1000, reached_limit: true }],
				convergence_warnings: ["Maximum number of iteration reached before convergence."],
			},
		}), view);
		expect(text).toContain("1000 of 1000 epochs, allowance reached");
		expect(text).toContain("ConvergenceWarning: Maximum number of iteration reached");
	});

	test("marks a canary-sample count as this fit's rather than a full pass's", () => {
		const text = renderIterationSignal(signal({ convergence: { ...fullSize, scope: "canary_sample", rows: 400 } }), view);
		expect(text).toContain("400-row sample");
		expect(text).toContain("not a full pass");
	});

	test("survives an unmeasurable iteration, where it is the only fit evidence left", () => {
		const text = renderIterationSignal(parseIterationSignal({
			ok: false,
			errors: ["metrics.json was not written"],
			convergence: { ...fullSize, scope: "canary_sample", rows: 400 },
		}), view);
		expect(text).toContain("7 of 1000 epochs");
	});

	test("says nothing at all when no estimator reported convergence", () => {
		const text = renderIterationSignal(signal({ convergence: { ...fullSize, estimators: [] } }), view);
		expect(text).not.toContain("work done");
	});
});
