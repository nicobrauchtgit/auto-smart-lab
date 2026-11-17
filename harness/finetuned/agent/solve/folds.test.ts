import { describe, expect, test } from "bun:test";

import { createStratifiedFolds, recommendFolds, sealFamilies, sealConfirmationSet } from "./folds.js";
import type { TrainingLabelRow } from "../team/contracts.js";

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
	test("class counts determine target, reduced and absent precision", () => {
		const corpus = (zero: number, one: number) => Array.from({ length: zero + one }, (_, index) => ({ id: `sample-${index}`, label: (index < zero ? 0 : 1) as 0 | 1 }));
		expect(sealConfirmationSet(corpus(8360, 8302))).toMatchObject({ precision: "target", perClass: { "0": 201, "1": 200 }, rows: 401 });
		expect(sealConfirmationSet(corpus(13074, 5682))).toMatchObject({ precision: "target", perClass: { "0": 460, "1": 200 }, rows: 660 });
		expect(sealConfirmationSet(corpus(3007, 554))).toMatchObject({ precision: "reduced", fraction: .2, perClass: { "0": 601, "1": 111 }, rows: 712 });
		expect(sealConfirmationSet(corpus(100, 20))).toMatchObject({ precision: "none", fraction: 0, sealedIds: [], rows: 0 });
	});
	test("rounds exact per-class counts half up", () => {
		const split = sealConfirmationSet(rows(55), { policy: { targetSmallestClassRows: 20, minSmallestClassRows: 1, maxFraction: .25 } });
		expect(split.perClass).toEqual({ "0": 7, "1": 7 });
	});
	test("draws the requested fraction, stratified", () => {
		const split = sealConfirmationSet(rows(1_000), { policy: { targetSmallestClassRows: 50, minSmallestClassRows: 20, maxFraction: .2 }, seed: 13 });
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
		expect(() => sealConfirmationSet(rows(100), { policy: { targetSmallestClassRows: 200, minSmallestClassRows: 50, maxFraction: 0 } })).toThrow();
		expect(() => sealConfirmationSet(rows(100), { policy: { targetSmallestClassRows: 20, minSmallestClassRows: 50, maxFraction: .2 } })).toThrow();
	});
});

describe("createStratifiedFolds", () => {
	test("is deterministic and keeps both classes in every fold", () => {
		const labels = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
		const first = createStratifiedFolds(labels, 3, 42);
		const second = createStratifiedFolds(labels, 3, 42);

		expect(first).toEqual(second);
		expect(first.flat().sort((a, b) => a - b)).toEqual(labels.map((_, index) => index));
		for (const fold of first) {
			expect(fold.map((row) => labels[row]).sort()).toEqual([0, 0, 1, 1]);
		}
	});

	test("rejects a fold count larger than either class", () => {
		expect(() => createStratifiedFolds([0, 0, 1], 2, 13)).toThrow("Each class");
	});
});

test("binary split hashes retain the pre-family-draw outputs", () => {
 const cases = [
  [8360, 8302, "c08b0fc9121a66ad719c66c12e5aa1a2bb4da75179d749e97a22533a887fe58d"],
  [13074, 5682, "52c4feeb0fe59f84111ff0486015b7ff89ae05a7e32857b98e83239e2d6edb1a"],
  [3007, 554, "c0436c37f937b81dce92aa828fa2b49e86299567998fce3944ff3f308981847f"],
 ] as const;
 for (const [zero, one, hash] of cases) expect(sealConfirmationSet(Array.from({ length: zero + one },
  (_, i) => ({ id: `sample-${i}`, label: (i < zero ? 0 : 1) as 0 | 1 }))).sha256).toBe(hash);
});

test("family rows seal a rounded fifth and retain singleton families", () => {
 const rows = [538, 73, 25, 21, 1, 2].flatMap((size, family) =>
  Array.from({ length: size }, (_, i) => ({ id: `${family}/${i}`, group: String(family) })));
 const split = sealFamilies(rows, 13);
 expect(split.confirmation.perClass).toEqual({ "0": 108, "1": 15, "2": 5, "3": 4, "4": 0, "5": 1 });
 expect(split.devIds).toContain("4/0");
 expect(split.devIds.some(id => id.startsWith("5/"))).toBe(true);
 expect(sealFamilies([...rows].reverse(), 13)).toEqual(split);
 expect(new Set([...split.devIds, ...split.sealedIds]).size).toBe(rows.length);
 expect(split.devIds.some(id => split.sealedIds.includes(id))).toBe(false);
 expect(sealFamilies([{ id: "one", group: "one" }], 13).confirmation.precision).toBe("none");
});
