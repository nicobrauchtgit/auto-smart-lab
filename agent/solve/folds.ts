/**
 * Fold sizing and the locked confirmation split.
 *
 * The fold table is a recommendation the solve agent may depart from; it exists
 * so a small dataset is not evaluated on five folds of a few hundred rows. The
 * sealed split is not a recommendation: it is withheld from the agent for the
 * whole run so the dev-to-sealed gap measures how far an iterative loop drifted
 * from its own out-of-fold estimate.
 */

import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash } from "node:crypto";

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
	const { folds, repeats } = HARNESS_CONFIG.foldRecommendations.find(row => row.belowRows === null || rows < row.belowRows)!;
	const shape = { folds, repeats };
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
	const fraction = options.fraction ?? HARNESS_CONFIG.solve.sealedFraction;
	const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
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

function seededShuffle(values: number[], seed: number): void {
	let state = seed >>> 0;
	for (let index = values.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const target = state % (index + 1);
		[values[index], values[target]] = [values[target], values[index]];
	}
}

/** Deterministic stratified folds of row indices for binary labels. */
export function createStratifiedFolds(labels: readonly number[], foldCount: number, seed: number): number[][] {
	if (labels.length === 0) throw new Error("Stratified folds require at least one row");
	if (labels.some((label) => label !== 0 && label !== 1)) {
		throw new Error("Stratified folds currently support binary labels 0 and 1 only");
	}
	if (!Number.isInteger(foldCount) || foldCount < 2) {
		throw new Error("foldCount must be an integer of at least 2");
	}
	const byClass: [number[], number[]] = [[], []];
	labels.forEach((label, index) => byClass[label as 0 | 1].push(index));
	if (byClass.some((indices) => indices.length < foldCount)) {
		throw new Error("Each class must have at least foldCount rows");
	}
	const folds = Array.from({ length: foldCount }, () => [] as number[]);
	for (const [label, indices] of byClass.entries()) {
		seededShuffle(indices, seed + label * 9973);
		indices.forEach((row, index) => folds[index % foldCount].push(row));
	}
	for (const fold of folds) fold.sort((a, b) => a - b);
	return folds;
}
