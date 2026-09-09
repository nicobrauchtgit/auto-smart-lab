import { describe, expect, test } from "bun:test";

import { iterationSeed, recommendFolds, sealConfirmationSet } from "./folds.js";
import type { TrainingLabelRow } from "../research/startup_context.js";

function rows(count: number): TrainingLabelRow[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `data/train/${String(index).padStart(6, "0")}`,
		label: (index % 2) as 0 | 1,
	}));
}

describe("recommendFolds", () => {
	test("uses repeats only where the data is small enough to need them", () => {
		expect(recommendFolds(499)).toMatchObject({ folds: 10, repeats: 5 });
		expect(recommendFolds(500)).toMatchObject({ folds: 10, repeats: 3 });
		expect(recommendFolds(1_999)).toMatchObject({ folds: 10, repeats: 3 });
		expect(recommendFolds(2_000)).toMatchObject({ folds: 10, repeats: 1 });
		expect(recommendFolds(9_999)).toMatchObject({ folds: 10, repeats: 1 });
		expect(recommendFolds(10_000)).toMatchObject({ folds: 5, repeats: 1 });
	});

	test("spam1 after sealing lands on five folds", () => {
		expect(recommendFolds(14_996)).toMatchObject({ scheme: "stratified_kfold", folds: 5, repeats: 1 });
	});

	test("rejects a row count that cannot describe a dataset", () => {
		expect(() => recommendFolds(0)).toThrow();
		expect(() => recommendFolds(1.5)).toThrow();
	});
});

describe("sealConfirmationSet", () => {
	test("draws the requested fraction, stratified", () => {
		const split = sealConfirmationSet(rows(1_000), { fraction: 0.1, seed: 13 });
		expect(split.sealedIds).toHaveLength(100);
		expect(split.devRows).toHaveLength(900);
		const sealed = new Set(split.sealedIds);
		const sealedLabels = rows(1_000).filter((row) => sealed.has(row.id));
		expect(sealedLabels.filter((row) => row.label === 0)).toHaveLength(50);
		expect(sealedLabels.filter((row) => row.label === 1)).toHaveLength(50);
	});

	test("is stable at a fixed seed and moves with the seed", () => {
		const first = sealConfirmationSet(rows(1_000), { seed: 13 });
		const again = sealConfirmationSet(rows(1_000), { seed: 13 });
		const other = sealConfirmationSet(rows(1_000), { seed: 14 });
		expect(again.sealedIds).toEqual(first.sealedIds);
		expect(again.sha256).toBe(first.sha256);
		expect(other.sealedIds).not.toEqual(first.sealedIds);
	});

	test("does not depend on the order rows arrive in", () => {
		const ordered = rows(1_000);
		const shuffled = [...ordered].reverse();
		expect(sealConfirmationSet(shuffled, { seed: 13 }).sealedIds)
			.toEqual(sealConfirmationSet(ordered, { seed: 13 }).sealedIds);
	});

	test("sealed and development rows are disjoint and cover the input", () => {
		const split = sealConfirmationSet(rows(1_000), { seed: 13 });
		const sealed = new Set(split.sealedIds);
		expect(split.devRows.some((row) => sealed.has(row.id))).toBe(false);
		expect(new Set([...sealed, ...split.devRows.map((row) => row.id)]).size).toBe(1_000);
	});

	test("rejects a fraction that would seal too much", () => {
		expect(() => sealConfirmationSet(rows(100), { fraction: 0 })).toThrow();
		expect(() => sealConfirmationSet(rows(100), { fraction: 0.9 })).toThrow();
	});
});

describe("iterationSeed", () => {
	test("rotates per iteration and is reproducible per run", () => {
		const first = iterationSeed("run-a", 1);
		expect(iterationSeed("run-a", 1)).toBe(first);
		expect(iterationSeed("run-a", 2)).not.toBe(first);
		expect(iterationSeed("run-b", 1)).not.toBe(first);
	});
});
