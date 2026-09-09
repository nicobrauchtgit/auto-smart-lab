/**
 * Typed access to one iteration's measurements.
 *
 * The numbers are computed in `agent/solve/iteration.py`, which recomputes every
 * reported figure from the agent's own predictions, scores the sealed split, runs
 * the leakage canary, and compares the challenger against the champion. This
 * module runs it, validates the shape of what comes back, and renders the part
 * the agent is shown.
 *
 * Keeping the arithmetic in one language avoids two implementations of balanced
 * accuracy and the paired bootstrap drifting apart.
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
const AGENT_DIR = resolve(HERE, "..");

/**
 * Why the canary reached its verdict.
 *
 * A failure is not automatically a leak. The check has to load the agent's
 * entrypoint and re-fit its pipeline before it can compare anything, and either
 * can fail on its own. Only `id_dependence` says the model read the id.
 */
export type CanaryKind = "passed" | "id_dependence" | "entrypoint_failed" | "fit_failed" | "sample_unusable";

export interface CanaryResult {
	passed: boolean;
	reason: string;
	examples: number;
	/** Absent only from a signal older than the field; the reason still stands. */
	kind?: CanaryKind;
	/** Wall time of one fit on `examples` rows; the basis of the cost projection. */
	fit_seconds?: number;
}

/**
 * What the agent's representation costs, projected from the canary's own fit.
 *
 * An expensive pipeline is otherwise invisible until the session runs out, which
 * is after the budget is spent rather than before. The projection assumes fit
 * time is linear in rows; superlinear estimators will exceed it, so it reads as
 * a floor rather than a forecast.
 */
export interface IterationCost {
	fit_seconds: number;
	fit_rows: number;
	seconds_per_1000_rows: number;
	estimated_cv_seconds: number;
	development_rows: number;
	folds: number;
	session_seconds?: number;
	share_of_session?: number;
}

export interface FoldScore {
	repeat: number;
	fold: number;
	n: number;
	bacc: number;
	recall_0: number;
	recall_1: number;
	roc_auc?: number;
}

export interface PairedComparison {
	available: boolean;
	reason?: string;
	champion_bacc?: number;
	challenger_bacc?: number;
	delta?: number;
	low?: number;
	high?: number;
	clears_zero?: boolean;
	corrected?: number;
	introduced?: number;
	folds_improved?: number;
	folds_total?: number;
	recall_0_delta?: number;
	recall_1_delta?: number;
}

export interface IterationSignal {
	ok: boolean;
	errors: string[];
	reported?: {
		mean_bacc?: number;
		approach?: string;
		variants_compared?: number;
		done?: boolean;
		cv?: Record<string, unknown>;
	};
	/**
	 * Present whenever any fold could be scored, including when compliance
	 * failed and the numbers cover only part of the development set.
	 */
	recomputed?: {
		mean_bacc: number;
		pooled_bacc: number;
		fold_low: number;
		fold_high: number;
		recall_0: number;
		recall_1: number;
		folds: FoldScore[];
	};
	/** How much of the development set the recomputation covers. */
	coverage?: { scored: number; development_rows: number; complete: boolean };
	/** Reported figures that do not match the recomputed ones. */
	discrepancies?: Array<{ field: string; reported: number; recomputed: number }>;
	/** Withheld from the agent until the final iteration. */
	sealed?: { n: number; bacc: number; gap: number };
	roc_auc?: number;
	threshold?: Record<string, unknown>;
	canary?: CanaryResult;
	/** Present whenever the canary managed a fit, measurable iteration or not. */
	cost?: IterationCost;
	paired?: PairedComparison | null;
	entrypoint?: { module: string; factory: string };
}

export interface EvaluateIterationOptions {
	workspace: string;
	labelsPath: string;
	sealedPath: string;
	zipPath: string;
	pythonExecutable: string;
	seed: number;
	folds: number;
	champion?: { module: string; factory: string; root: string };
	bootstrapResamples?: number;
	/** Agent session budget, so the cost projection is stated against it. */
	sessionSeconds?: number;
	/** Scaffolded entrypoint, used when metrics.json declares none. */
	entrypointModule?: string;
	signal?: AbortSignal;
}

/** Run the evaluator and return its signal. A crash becomes a failed signal, not a throw. */
export async function evaluateIteration(options: EvaluateIterationOptions): Promise<IterationSignal> {
	const argv = [
		"-m", "solve.iteration",
		"--workspace", options.workspace,
		"--project-root", PROJECT_ROOT,
		"--labels", options.labelsPath,
		"--sealed", options.sealedPath,
		"--zip", options.zipPath,
		"--seed", String(options.seed),
		"--folds", String(options.folds),
		"--bootstrap-resamples", String(options.bootstrapResamples ?? 2000),
		"--session-seconds", String(options.sessionSeconds ?? 0),
		"--entrypoint-module", options.entrypointModule ?? "",
		...(options.champion
			? ["--champion-module", options.champion.module,
				"--champion-factory", options.champion.factory,
				"--champion-root", options.champion.root]
			: []),
	];
	const result = await run(options.pythonExecutable, argv, options.signal);
	if (result.stdout.trim().length === 0) {
		return { ok: false, errors: [`the iteration evaluator produced no output: ${result.stderr.trim().slice(-500) || "no diagnostics"}`] };
	}
	try {
		return parseIterationSignal(JSON.parse(result.stdout));
	} catch (error) {
		return { ok: false, errors: [`the iteration evaluator returned unusable output: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

function run(executable: string, argv: string[], abort?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
	return new Promise((settle, fail) => {
		const child = spawn(executable, argv, {
			cwd: AGENT_DIR,
			env: {
				...process.env,
				// `solve.iteration` lives under agent/; smartlab_eval is installed.
				PYTHONPATH: [AGENT_DIR, process.env.PYTHONPATH].filter(Boolean).join(":"),
			},
			...(abort ? { signal: abort } : {}),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", fail);
		child.on("close", () => settle({ stdout, stderr }));
	});
}

/** Reject anything that is not a signal before it reaches the trace or a prompt. */
export function parseIterationSignal(raw: unknown): IterationSignal {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("signal must be an object");
	const value = raw as Record<string, unknown>;
	if (typeof value.ok !== "boolean") throw new Error("signal.ok must be a boolean");
	if (!Array.isArray(value.errors) || value.errors.some((entry) => typeof entry !== "string")) {
		throw new Error("signal.errors must be an array of strings");
	}
	if (value.canary !== undefined) assertCanary(value.canary);
	if (value.recomputed !== undefined) assertRecomputed(value.recomputed);

	// An unmeasurable iteration still carries whatever could be computed: the
	// canary always, and partial fold scores whenever any rows were scorable.
	// Dropping them here is what left a compliance failure with no feedback.
	if (!value.ok) {
		return {
			ok: false,
			errors: value.errors as string[],
			reported: value.reported as IterationSignal["reported"],
			recomputed: value.recomputed as IterationSignal["recomputed"],
			coverage: value.coverage as IterationSignal["coverage"],
			canary: value.canary as CanaryResult | undefined,
			cost: value.cost as IterationCost | undefined,
			roc_auc: typeof value.roc_auc === "number" ? value.roc_auc : undefined,
			entrypoint: value.entrypoint as IterationSignal["entrypoint"],
		};
	}

	if (value.recomputed === undefined) throw new Error("a measurable signal must carry signal.recomputed");
	const sealed = value.sealed as IterationSignal["sealed"];
	if (typeof sealed?.bacc !== "number" || typeof sealed?.gap !== "number") {
		throw new Error("signal.sealed must carry a score and a gap");
	}
	if (value.canary === undefined) throw new Error("a measurable signal must carry signal.canary");
	return value as unknown as IterationSignal;
}

const CANARY_KINDS: readonly CanaryKind[] = ["passed", "id_dependence", "entrypoint_failed", "fit_failed", "sample_unusable"];

function assertCanary(raw: unknown): void {
	const canary = raw as CanaryResult;
	if (typeof canary?.passed !== "boolean" || typeof canary?.reason !== "string") {
		throw new Error("signal.canary must report a pass and a reason");
	}
	// An unrecognised kind is reported as an unexplained failure rather than
	// thrown away: the reason it carries is still worth showing.
	if (canary.kind !== undefined && !CANARY_KINDS.includes(canary.kind)) {
		throw new Error(`signal.canary.kind must be one of ${CANARY_KINDS.join(", ")}`);
	}
}

function assertRecomputed(raw: unknown): void {
	const recomputed = raw as NonNullable<IterationSignal["recomputed"]>;
	for (const key of ["mean_bacc", "pooled_bacc", "fold_low", "fold_high"] as const) {
		if (typeof recomputed?.[key] !== "number" || !Number.isFinite(recomputed[key])) {
			throw new Error(`signal.recomputed.${key} must be a finite number`);
		}
	}
	if (!Array.isArray(recomputed?.folds) || recomputed.folds.length === 0) {
		throw new Error("signal.recomputed.folds must not be empty");
	}
}

const round = (value: number, digits = 4) => value.toFixed(digits);
const signed = (value: number, digits = 4) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

/** Spelled out, because "+4 errors" reads as four more when it means four fewer. */
function netErrors(corrected: number, introduced: number): string {
	const net = corrected - introduced;
	if (net === 0) return "no net change in errors";
	return `net ${Math.abs(net)} ${net > 0 ? "fewer" : "more"} errors`;
}

/** The projected cost line, when the canary managed a fit. */
function costLine(cost: IterationCost): string {
	const perThousand = cost.seconds_per_1000_rows;
	const projected = cost.estimated_cv_seconds;
	const shape = `${cost.folds}-fold over ${cost.development_rows.toLocaleString()} rows`;
	const budget = cost.share_of_session !== undefined
		? `, ${Math.round(cost.share_of_session * 100)}% of one session`
		: "";
	const projectedText = projected >= 120 ? `${(projected / 60).toFixed(1)} min` : `${projected.toFixed(0)} s`;
	return `${perThousand.toFixed(1)} s per 1,000 rows -> ~${projectedText} for ${shape}${budget}`;
}

const canaryLine = (canary: CanaryResult) => canary.passed ? "passed" : `FAILED - ${canary.reason}`;

/**
 * What a canary failure actually establishes.
 *
 * Only `id_dependence` is evidence about the model. The other kinds mean the
 * check could not run, and saying "these scores do not describe a model that
 * would work" for those sends the agent hunting a leak that is not there.
 * Promotion is blocked in every case, because an unverified pipeline is not a
 * verified one.
 */
function canaryVerdict(canary: CanaryResult): string {
	switch (canary.kind) {
		case "id_dependence":
			return "Your pipeline's output changes when only the filename changes, so these scores do not describe a model that would work on the test set.";
		case "entrypoint_failed":
			return "The canary could not load the entrypoint named in metrics.json, so your pipeline was never checked. This is about the declared path, not about the model.";
		case "fit_failed":
			return "The canary could not re-fit your pipeline from its factory on a sample of the training rows. The factory has to return an unfitted estimator that fits an id/text frame on its own.";
		case "sample_unusable":
			return "The canary could not assemble a sample to check against, so no leakage check ran. Nothing here points at your model.";
		case "passed":
			return "The canary passed.";
		default:
			return `The canary did not pass: ${canary.reason}`;
	}
}

export interface RenderSignalOptions {
	iteration: number;
	maxIterations: number;
	seed: number;
	/** The sealed score is shown only once the loop is over. */
	revealSealed: boolean;
	isChampion: boolean;
}

/**
 * The block the agent sees. Measurements only: no advice on what to try next and
 * no judgement of the approach, so the agent's next move comes from evidence
 * rather than from the harness's opinion.
 */
export function renderIterationSignal(signal: IterationSignal, options: RenderSignalOptions): string {
	const lines = [`Iteration ${options.iteration} of ${options.maxIterations}    fold seed ${options.seed}`];
	if (!signal.ok) {
		lines.push("", "Your results could not be measured:");
		for (const error of signal.errors) lines.push(`  - ${error}`);
		lines.push("", "No score was recorded for this iteration and nothing was promoted.");
		// A results file that does not comply says nothing about the model. What
		// was still measurable is shown anyway, because the usual cause is a
		// formatting mistake and discarding the diagnostics with it wastes the
		// whole iteration.
		const partial = signal.recomputed;
		if (partial) {
			const scored = signal.coverage
				? `${signal.coverage.scored} of ${signal.coverage.development_rows} development rows`
				: "the rows that could be scored";
			lines.push("", `Measured anyway, over ${scored}:`,
				`  mean BACC     ${round(partial.mean_bacc)}   folds ${round(partial.fold_low)}-${round(partial.fold_high)}`,
				`  recall        class 0 ${round(partial.recall_0)}   class 1 ${round(partial.recall_1)}`);
			if (typeof signal.roc_auc === "number") lines.push(`  ROC AUC       ${round(signal.roc_auc)}`);
			lines.push("", "  These numbers are not comparable across iterations and were not recorded.");
		}
		if (signal.cost) lines.push("", `  fit cost      ${costLine(signal.cost)}`);
		if (signal.canary) lines.push("", `  canary        ${canaryLine(signal.canary)}`, "", `  ${canaryVerdict(signal.canary)}`);
		return lines.join("\n");
	}
	const measured = signal.recomputed!;
	lines.push("",
		`  mean BACC     ${round(measured.mean_bacc)}   folds ${round(measured.fold_low)}-${round(measured.fold_high)}`,
		`  recall        class 0 ${round(measured.recall_0)}   class 1 ${round(measured.recall_1)}`);
	if (typeof signal.roc_auc === "number") lines.push(`  ROC AUC       ${round(signal.roc_auc)}`);

	if (signal.discrepancies?.length) {
		lines.push("", "  Reported numbers that do not match the recomputed ones:");
		for (const item of signal.discrepancies) {
			lines.push(`    ${item.field}: you reported ${round(item.reported, 6)}, the predictions give ${round(item.recomputed, 6)}`);
		}
	}

	const paired = signal.paired;
	if (paired?.available) {
		lines.push("",
			`  vs champion   ${signed(paired.delta!)}   [${signed(paired.low!)}, ${signed(paired.high!)}]`,
			`  folds improved     ${paired.folds_improved} / ${paired.folds_total}`,
			`  corrected ${paired.corrected}   introduced ${paired.introduced}   ${netErrors(paired.corrected!, paired.introduced!)}`,
			`  recall delta  c0 ${signed(paired.recall_0_delta!)}   c1 ${signed(paired.recall_1_delta!)}`);
	} else if (paired && !paired.available) {
		lines.push("", `  vs champion   unavailable: ${paired.reason}`);
	}

	if (signal.cost) lines.push("", `  fit cost      ${costLine(signal.cost)}`);
	lines.push("", `  canary        ${canaryLine(signal.canary!)}`);

	if (options.revealSealed && signal.sealed) {
		lines.push("",
			`  sealed split  ${round(signal.sealed.bacc)} on ${signal.sealed.n} rows held out of every fold`,
			`  dev-to-sealed gap ${signed(signal.sealed.gap)}`);
	}

	lines.push("");
	if (!signal.canary!.passed) {
		lines.push(`  ${canaryVerdict(signal.canary!)}`);
	} else if (paired?.available) {
		lines.push(paired.clears_zero
			? "  The delta clears its interval. This is the new champion."
			: "  The delta does not clear its interval. Champion unchanged.");
	} else if (options.isChampion) {
		lines.push("  First measured result. This is the champion.");
	}
	return lines.join("\n");
}
