import { describe, expect, test } from "bun:test";

import {
	auditFeatureGroup,
	createStratifiedFolds,
	featureAuditToJson,
	featureAuditToMarkdown,
} from "./feature_audit.js";

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
		expect(() => createStratifiedFolds([0, 0, 1], 2)).toThrow("Each class");
	});
});

describe("auditFeatureGroup", () => {
	const labels = [0, 0, 0, 0, 1, 1, 1, 1];

	test("finds health problems and duplicate columns", () => {
		const report = auditFeatureGroup(labels, [
			{ name: "constant", kind: "numeric", train: [3, 3, 3, 3, 3, 3, 3, 3] },
			{ name: "signal", kind: "numeric", train: [0, 1, null, Number.NaN, 8, 9, 10, 11] },
			{ name: "signal-copy", kind: "numeric", train: [0, 1, null, Number.NaN, 8, 9, 10, 11] },
		], { foldCount: 2 });

		expect(report.constantColumns).toEqual(["constant"]);
		expect(report.duplicateColumns).toEqual([{ first: "signal", duplicate: "signal-copy" }]);
		expect(report.features[1].health).toMatchObject({ missing: 1, nonFinite: 1, valid: 6, unique: 6 });
	});

	test("measures a perfect numeric signal without fitting on validation rows", () => {
		const report = auditFeatureGroup(labels, [{
			name: "score",
			kind: "numeric",
			train: [0, 1, 2, 3, 10, 11, 12, 13],
			test: [2, 20, null],
		}], { foldCount: 2, seed: 7 });
		const feature = report.features[0];

		expect(feature.association.auc).toBe(1);
		expect(feature.association.aucDirection).toBe("higher");
		expect(feature.association.crossValidatedBalancedAccuracy).toBe(1);
		expect(feature.association.folds).toHaveLength(2);
		expect(feature.test).toEqual({ missing: 1, nonFinite: 0, unseenValues: 1 });
	});

	test("reports binary association and validates binary values", () => {
		const report = auditFeatureGroup(labels, [{
			name: "flag",
			kind: "binary",
			train: [0, 0, 0, 0, 1, 1, 1, 1],
		}], { foldCount: 2 });
		const association = report.features[0].association;

		expect(association.class0Prevalence).toBe(0);
		expect(association.class1Prevalence).toBe(1);
		expect(association.chiSquare).toBe(8);
		expect(association.smoothedLogOdds).toBeGreaterThan(0);
		expect(() => auditFeatureGroup(labels, [{
			name: "bad",
			kind: "binary",
			train: [0, 0, 0, 0, 1, 1, 1, 2],
		}], { foldCount: 2 })).toThrow("other than 0 or 1");
	});

	test("renders a compact Markdown report and remains JSON serializable", () => {
		const report = auditFeatureGroup(labels, [{
			name: "flag",
			kind: "binary",
			train: [0, 0, 0, 0, 1, 1, 1, 1],
		}], { foldCount: 2 });
		const markdown = featureAuditToMarkdown(report);

		expect(markdown).toContain("# Feature audit");
		expect(markdown).toContain("| flag | binary |");
		expect(JSON.parse(featureAuditToJson(report))).toEqual(report);
	});
});
