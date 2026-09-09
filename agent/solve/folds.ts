/**
 * Fold sizing and the locked confirmation split.
 *
 * The fold table is a recommendation the solve agent may depart from; it exists
 * so a small dataset is not evaluated on five folds of a few hundred rows. The
 * sealed split is not a recommendation: it is withheld from the agent for the
 * whole run so the dev-to-sealed gap measures how far an iterative loop drifted
 * from its own out-of-fold estimate.
 */

import { createHash } from "node:crypto";

import { createStratifiedFolds } from "../pipeline/feature_audit.js";
import type { TrainingLabelRow } from "../research/startup_context.js";

export interface FoldRecommendation {
	scheme: "stratified_kfold";
	folds: number;
	repeats: number;
	/** Why this shape was suggested, for the prompt and the trace. */
	rationale: string;
}

/**
 * Fold shape by training-row count. Small datasets buy a lower-variance estimate
 * with repeats, which cost little when the data is small; large ones do not need
 * them and would pay for the extra fits.
 */
export function recommendFolds(rows: number): FoldRecommendation {
	if (!Number.isInteger(rows) || rows < 1) throw new Error("recommendFolds needs a positive integer row count");
	const shape = rows < 500 ? { folds: 10, repeats: 5 }
		: rows < 2_000 ? { folds: 10, repeats: 3 }
		: rows < 10_000 ? { folds: 10, repeats: 1 }
		: { folds: 5, repeats: 1 };
	return {
		scheme: "stratified_kfold",
		...shape,
		rationale: `${rows} training rows after sealing`,
	};
}

export interface SealedSplit {
	/** Ids withheld from the agent's labels file for the whole run. */
	sealedIds: string[];
	/** Rows the agent may train and cross-validate on. */
	devRows: TrainingLabelRow[];
	fraction: number;
	seed: number;
	/** Identifies this split in the trace and in every iteration record. */
	sha256: string;
}

/**
 * Draw a stratified confirmation set that stays identical for a task across every
 * iteration and every run at the same seed, so repeated runs are comparable and
 * the split cannot drift into data the agent has already optimised against.
 *
 * The draw reuses `createStratifiedFolds`: one fold of `round(1 / fraction)` is
 * exactly a stratified sample of that fraction, so there is no second splitter to
 * keep in step with the first.
 */
export function sealConfirmationSet(
	rows: readonly TrainingLabelRow[],
	options: { fraction?: number; seed?: number } = {},
): SealedSplit {
	const fraction = options.fraction ?? 0.1;
	const seed = options.seed ?? 13;
	if (!(fraction > 0 && fraction < 1)) throw new Error("sealed fraction must be between 0 and 1");
	const parts = Math.round(1 / fraction);
	if (parts < 2) throw new Error("sealed fraction must leave at least half the rows for development");
	// Ordering is fixed before the draw so the split depends on the seed and the
	// row set, never on the order the labels file happened to arrive in.
	const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
	const folds = createStratifiedFolds(ordered.map((row) => row.label), parts, seed);
	const sealedRows = new Set(folds[0]);
	const sealedIds = folds[0].map((index) => ordered[index].id).sort();
	const devRows = ordered.filter((_, index) => !sealedRows.has(index));
	return {
		sealedIds,
		devRows,
		fraction,
		seed,
		sha256: createHash("sha256").update(JSON.stringify({ seed, fraction, sealedIds })).digest("hex"),
	};
}

/**
 * Fold seed for one iteration. Rotating it means a gain that exists only on one
 * partition does not survive into the next iteration, which is the cheapest
 * defence against grinding a fixed split across a long improvement loop.
 */
export function iterationSeed(runId: string, iteration: number): number {
	const digest = createHash("sha256").update(`${runId}:${iteration}`).digest();
	return digest.readUInt32BE(0) % 100_000;
}
