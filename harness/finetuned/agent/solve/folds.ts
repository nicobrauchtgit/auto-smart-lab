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
	scheme: "stratified_kfold" | "group_kfold" | "kfold";
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
export function recommendFolds(rows: number, options: { scheme?: FoldRecommendation["scheme"]; groups?: number } = {}): FoldRecommendation {
	if (!Number.isInteger(rows) || rows < 1) throw new Error("recommendFolds needs a positive integer row count");
	const { folds, repeats } = HARNESS_CONFIG.foldRecommendations.find(row => row.belowRows === null || rows < row.belowRows)!;
	const scheme = options.scheme ?? "stratified_kfold";
	// Whole groups are held out, so a fold needs groups, not just rows.
	const groupFolds = scheme === "group_kfold" && options.groups !== undefined ? Math.max(2, Math.min(folds, options.groups)) : folds;
	return {
		scheme,
		folds: groupFolds,
		repeats,
		rationale: scheme === "group_kfold" ? `${rows} training rows in ${options.groups} groups after sealing` : `${rows} training rows after sealing`,
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

export interface HoldoutPolicy {
    targetSmallestClassRows: number;
    minSmallestClassRows: number;
    maxFraction: number;
}
export interface HoldoutMetadata {
    rows: number;
    perClass: Record<string, number>;
    precision: "target" | "reduced" | "none";
    reason?: string;
}

/** Exact, size-aware stratified draw; input ordering never affects membership. */
export function sealConfirmationSet(
    rows: readonly TrainingLabelRow[],
    options: { policy?: HoldoutPolicy; seed?: number } = {},
): SealedSplit & HoldoutMetadata {
    const policy = options.policy ?? HARNESS_CONFIG.holdout;
    const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
    if (!Number.isSafeInteger(policy.targetSmallestClassRows) || policy.targetSmallestClassRows < 1
        || !Number.isSafeInteger(policy.minSmallestClassRows) || policy.minSmallestClassRows < 1
        || policy.minSmallestClassRows > policy.targetSmallestClassRows
        || !(policy.maxFraction > 0 && policy.maxFraction < 0.5)) throw new Error("Invalid holdout policy");
    if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length
        || rows.some(row => row.label !== 0 && row.label !== 1)) throw new Error("Holdout needs unique binary-labelled rows");
    const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const classes = [ordered.filter(row => row.label === 0), ordered.filter(row => row.label === 1)];
    const smallest = Math.min(...classes.map(values => values.length));
    const requested = smallest ? policy.targetSmallestClassRows / smallest : Infinity;
    let fraction = Math.min(requested, policy.maxFraction);
    let precision: HoldoutMetadata["precision"] = requested <= policy.maxFraction ? "target" : "reduced";
    if (Math.floor(smallest * fraction + 0.5) < policy.minSmallestClassRows) { fraction = 0; precision = "none"; }
    const perClass: Record<string, number> = {};
    const sealedIds: string[] = [];
    classes.forEach((values, label) => {
        const indices = values.map((_, index) => index);
        seededShuffle(indices, seed + label * 9973);
        const count = Math.floor(values.length * fraction + 0.5);
        perClass[String(label)] = count;
        sealedIds.push(...indices.slice(0, count).map(index => values[index].id));
    });
    sealedIds.sort();
    const sealed = new Set(sealedIds);
    return { sealedIds, devRows: ordered.filter(row => !sealed.has(row.id)), fraction, seed,
        rows: sealedIds.length, perClass, precision,
        ...(precision === "none" ? { reason: "Too few rows in the smallest class for an independent confirmation estimate" } : {}),
        sha256: createHash("sha256").update(JSON.stringify({ version: 2, seed, policy, sealedIds })).digest("hex") };
}

/** A sealed split over arbitrary IDs; family tasks seal whole families. */
export interface IdSealedSplit {
	scheme: "group" | "none";
	sealedIds: string[];
	devIds: string[];
	/** Number of whole groups sealed; zero without a holdout. */
	sealedGroups: number;
	fraction: number;
	seed: number;
	sha256: string;
}

/**
 * Seal whole families so the confirmation rows contain only families the agent
 * never saw, mirroring a test set of unseen families. Families are drawn in a
 * seeded order until at least the requested fraction of rows is sealed; at
 * least two families always stay in development.
 */
export function sealGroups(
	rows: readonly { id: string; group: string }[],
	options: { fraction?: number; seed?: number } = {},
): IdSealedSplit {
	const fraction = options.fraction ?? HARNESS_CONFIG.holdout.groupFraction;
	const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
	if (!(fraction > 0 && fraction < 0.5)) throw new Error("sealed fraction must be above 0 and below 0.5");
	const groups = [...new Set(rows.map(row => row.group))].sort();
	if (groups.length < 3) throw new Error("Sealing whole families needs at least three families");
	const order = groups.map((_, index) => index);
	seededShuffle(order, seed);
	const sizes = new Map<string, number>();
	for (const row of rows) sizes.set(row.group, (sizes.get(row.group) ?? 0) + 1);
	const sealed = new Set<string>();
	let sealedRows = 0;
	for (const index of order) {
		if (sealedRows >= fraction * rows.length || groups.length - sealed.size <= 2) break;
		const group = groups[index];
		// Never let one large family push the sealed share past one half.
		if (sealedRows + sizes.get(group)! > rows.length / 2) continue;
		sealed.add(group);
		sealedRows += sizes.get(group)!;
	}
	if (!sealed.size) throw new Error("No family is small enough to seal without taking half of the training rows");
	const sealedIds = rows.filter(row => sealed.has(row.group)).map(row => row.id).sort();
	const devIds = rows.filter(row => !sealed.has(row.group)).map(row => row.id).sort();
	return {
		scheme: "group", sealedIds, devIds, sealedGroups: sealed.size, fraction, seed,
		sha256: createHash("sha256").update(JSON.stringify({ scheme: "group", seed, fraction, sealedIds })).digest("hex"),
	};
}

/** No holdout: without targets there is nothing to confirm on sealed rows. */
export function noSeal(ids: readonly string[], seed: number): IdSealedSplit {
	return {
		scheme: "none", sealedIds: [], devIds: [...ids].sort(), sealedGroups: 0, fraction: 0, seed,
		sha256: createHash("sha256").update(JSON.stringify({ scheme: "none", seed, sealedIds: [] })).digest("hex"),
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
