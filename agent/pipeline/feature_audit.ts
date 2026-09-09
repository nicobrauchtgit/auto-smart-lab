export type BinaryLabel = 0 | 1;
export type FeatureKind = "numeric" | "binary";
export type FeatureValue = number | null;

export interface ScalarFeature {
	name: string;
	kind: FeatureKind;
	train: readonly FeatureValue[];
	test?: readonly FeatureValue[];
}

export interface FeatureAuditOptions {
	foldCount?: number;
	seed?: number;
	nearConstantFraction?: number;
}

export interface FoldResult {
	fold: number;
	balancedAccuracy: number;
	threshold: number;
	direction: "gte" | "lte";
}

export interface FeatureHealth {
	missing: number;
	nonFinite: number;
	valid: number;
	unique: number;
	zeroRate: number | null;
	constant: boolean;
	nearConstant: boolean;
}

export interface FeatureAssociation {
	auc: number | null;
	aucDirection: "higher" | "lower" | null;
	mutualInformation: number | null;
	class0Median: number | null;
	class1Median: number | null;
	class0Prevalence: number | null;
	class1Prevalence: number | null;
	smoothedLogOdds: number | null;
	chiSquare: number | null;
	crossValidatedBalancedAccuracy: number | null;
	folds: FoldResult[];
}

export interface FeatureResult {
	name: string;
	kind: FeatureKind;
	health: FeatureHealth;
	association: FeatureAssociation;
	test: {
		missing: number;
		nonFinite: number;
		unseenValues: number;
	} | null;
}

export interface FeatureAuditReport {
	schemaVersion: 1;
	rows: number;
	columns: number;
	foldCount: number;
	seed: number;
	constantColumns: string[];
	nearConstantColumns: string[];
	duplicateColumns: Array<{ first: string; duplicate: string }>;
	features: FeatureResult[];
}

const DEFAULT_FOLDS = 5;
const DEFAULT_SEED = 13;
const DEFAULT_NEAR_CONSTANT_FRACTION = 0.99;

function assertLabels(labels: readonly number[]): asserts labels is readonly BinaryLabel[] {
	if (labels.length === 0) throw new Error("Feature audit requires at least one row");
	if (labels.some((label) => label !== 0 && label !== 1)) {
		throw new Error("Feature audit currently supports binary labels 0 and 1 only");
	}
}

function finiteValues(values: readonly FeatureValue[]): number[] {
	return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function balancedAccuracy(labels: readonly BinaryLabel[], predictions: readonly BinaryLabel[]): number {
	let total0 = 0;
	let total1 = 0;
	let correct0 = 0;
	let correct1 = 0;
	for (let index = 0; index < labels.length; index++) {
		if (labels[index] === 0) {
			total0++;
			if (predictions[index] === 0) correct0++;
		} else {
			total1++;
			if (predictions[index] === 1) correct1++;
		}
	}
	if (total0 === 0 || total1 === 0) return Number.NaN;
	return (correct0 / total0 + correct1 / total1) / 2;
}

function seededShuffle(values: number[], seed: number): void {
	let state = seed >>> 0;
	for (let index = values.length - 1; index > 0; index--) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const target = state % (index + 1);
		[values[index], values[target]] = [values[target], values[index]];
	}
}

export function createStratifiedFolds(
	labels: readonly number[],
	foldCount = DEFAULT_FOLDS,
	seed = DEFAULT_SEED,
): number[][] {
	assertLabels(labels);
	if (!Number.isInteger(foldCount) || foldCount < 2) {
		throw new Error("foldCount must be an integer of at least 2");
	}
	const byClass: [number[], number[]] = [[], []];
	labels.forEach((label, index) => byClass[label].push(index));
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

function health(values: readonly FeatureValue[], nearConstantFraction: number): FeatureHealth {
	const valid = finiteValues(values);
	const counts = new Map<number, number>();
	for (const value of valid) counts.set(value, (counts.get(value) ?? 0) + 1);
	const largestCount = Math.max(0, ...counts.values());
	return {
		missing: values.filter((value) => value === null).length,
		nonFinite: values.filter((value) => value !== null && !Number.isFinite(value)).length,
		valid: valid.length,
		unique: counts.size,
		zeroRate: valid.length === 0 ? null : valid.filter((value) => value === 0).length / valid.length,
		constant: valid.length > 0 && counts.size === 1,
		nearConstant: valid.length > 0 && largestCount / valid.length >= nearConstantFraction,
	};
}

function auc(values: readonly FeatureValue[], labels: readonly BinaryLabel[]): number | null {
	const pairs = values.flatMap((value, index) =>
		value !== null && Number.isFinite(value) ? [{ value, label: labels[index] }] : [],
	);
	const positives = pairs.filter((pair) => pair.label === 1).length;
	const negatives = pairs.length - positives;
	if (positives === 0 || negatives === 0) return null;
	pairs.sort((a, b) => a.value - b.value);
	let positiveRankSum = 0;
	let index = 0;
	while (index < pairs.length) {
		let end = index + 1;
		while (end < pairs.length && pairs[end].value === pairs[index].value) end++;
		const averageRank = (index + 1 + end) / 2;
		for (let cursor = index; cursor < end; cursor++) {
			if (pairs[cursor].label === 1) positiveRankSum += averageRank;
		}
		index = end;
	}
	return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function mutualInformation(values: readonly number[], labels: readonly BinaryLabel[]): number | null {
	if (values.length === 0 || values.length !== labels.length) return null;
	const joint = new Map<string, number>();
	const valueCounts = new Map<number, number>();
	const labelCounts = [0, 0];
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		const label = labels[index];
		joint.set(`${value}\u0000${label}`, (joint.get(`${value}\u0000${label}`) ?? 0) + 1);
		valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
		labelCounts[label]++;
	}
	let result = 0;
	for (const [value, valueCount] of valueCounts) {
		for (const label of [0, 1] as const) {
			const count = joint.get(`${value}\u0000${label}`) ?? 0;
			if (count === 0 || labelCounts[label] === 0) continue;
			result += count / values.length * Math.log(
				(count * values.length) / (valueCount * labelCounts[label]),
			);
		}
	}
	return result;
}

function discretizeNumeric(values: readonly number[], bins = 10): number[] {
	if (values.length === 0) return [];
	const sorted = [...values].sort((a, b) => a - b);
	const boundaries = Array.from({ length: bins - 1 }, (_, index) =>
		sorted[Math.floor((index + 1) * sorted.length / bins)],
	);
	return values.map((value) => {
		let bin = 0;
		while (bin < boundaries.length && value > boundaries[bin]) bin++;
		return bin;
	});
}

function thresholdCandidates(values: readonly number[]): number[] {
	const unique = [...new Set(values)].sort((a, b) => a - b);
	if (unique.length === 0) return [];
	const candidates = [unique[0] - 1];
	for (let index = 1; index < unique.length; index++) {
		candidates.push(unique[index - 1] + (unique[index] - unique[index - 1]) / 2);
	}
	candidates.push(unique[unique.length - 1] + 1);
	return candidates;
}

function fitThreshold(values: readonly number[], labels: readonly BinaryLabel[]): {
	threshold: number;
	direction: "gte" | "lte";
} {
	let best = { threshold: 0, direction: "gte" as const, score: -Infinity };
	for (const threshold of thresholdCandidates(values)) {
		for (const direction of ["gte", "lte"] as const) {
			const predictions = values.map((value): BinaryLabel =>
				direction === "gte" ? (value >= threshold ? 1 : 0) : (value <= threshold ? 1 : 0),
			);
			const score = balancedAccuracy(labels, predictions);
			if (score > best.score) best = { threshold, direction, score };
		}
	}
	return { threshold: best.threshold, direction: best.direction };
}

function crossValidatedThreshold(
	values: readonly FeatureValue[],
	labels: readonly BinaryLabel[],
	folds: readonly number[][],
): FoldResult[] {
	const allRows = values.map((_, index) => index);
	return folds.flatMap((validationRows, fold) => {
		const validationSet = new Set(validationRows);
		const trainingRows = allRows.filter((row) => !validationSet.has(row) && values[row] !== null && Number.isFinite(values[row]));
		const usableValidationRows = validationRows.filter((row) => values[row] !== null && Number.isFinite(values[row]));
		if (trainingRows.length === 0 || usableValidationRows.length === 0) return [];
		const trainingLabels = trainingRows.map((row) => labels[row]);
		if (!trainingLabels.includes(0) || !trainingLabels.includes(1)) return [];
		const fitted = fitThreshold(trainingRows.map((row) => values[row] as number), trainingLabels);
		const validationLabels = usableValidationRows.map((row) => labels[row]);
		if (!validationLabels.includes(0) || !validationLabels.includes(1)) return [];
		const predictions = usableValidationRows.map((row): BinaryLabel => {
			const value = values[row] as number;
			return fitted.direction === "gte" ? (value >= fitted.threshold ? 1 : 0) : (value <= fitted.threshold ? 1 : 0);
		});
		return [{ fold, balancedAccuracy: balancedAccuracy(validationLabels, predictions), ...fitted }];
	});
}

function binaryStatistics(values: readonly number[], labels: readonly BinaryLabel[]): {
	class0Prevalence: number | null;
	class1Prevalence: number | null;
	smoothedLogOdds: number | null;
	chiSquare: number | null;
} {
	const counts = [[0, 0], [0, 0]];
	for (let index = 0; index < values.length; index++) counts[labels[index]][values[index] === 0 ? 0 : 1]++;
	const totals = counts.map((row) => row[0] + row[1]);
	const prevalence = totals.map((total, label) => total === 0 ? null : counts[label][1] / total);
	const logOdds = totals.some((total) => total === 0) ? null :
		Math.log((counts[1][1] + 0.5) / (counts[1][0] + 0.5)) -
		Math.log((counts[0][1] + 0.5) / (counts[0][0] + 0.5));
	const rowTotals = totals;
	const columnTotals = [counts[0][0] + counts[1][0], counts[0][1] + counts[1][1]];
	let chiSquare = 0;
	for (const label of [0, 1]) {
		for (const column of [0, 1]) {
			const expected = rowTotals[label] * columnTotals[column] / values.length;
			if (expected > 0) chiSquare += (counts[label][column] - expected) ** 2 / expected;
		}
	}
	return {
		class0Prevalence: prevalence[0],
		class1Prevalence: prevalence[1],
		smoothedLogOdds: logOdds,
		chiSquare: values.length === 0 ? null : chiSquare,
	};
}

function columnsEqual(left: readonly FeatureValue[], right: readonly FeatureValue[]): boolean {
	return left.length === right.length && left.every((value, index) =>
		Object.is(value, right[index]) ||
		(value !== null && right[index] !== null && Number.isNaN(value) && Number.isNaN(right[index] as number)),
	);
}

export function auditFeatureGroup(
	labelsInput: readonly number[],
	features: readonly ScalarFeature[],
	options: FeatureAuditOptions = {},
): FeatureAuditReport {
	assertLabels(labelsInput);
	const labels = labelsInput as readonly BinaryLabel[];
	const foldCount = options.foldCount ?? DEFAULT_FOLDS;
	const seed = options.seed ?? DEFAULT_SEED;
	const nearConstantFraction = options.nearConstantFraction ?? DEFAULT_NEAR_CONSTANT_FRACTION;
	if (!(nearConstantFraction > 0 && nearConstantFraction <= 1)) {
		throw new Error("nearConstantFraction must be greater than 0 and at most 1");
	}
	for (const feature of features) {
		if (feature.train.length !== labels.length) throw new Error(`Feature ${feature.name} has the wrong training row count`);
		if (feature.kind === "binary" && finiteValues(feature.train).some((value) => value !== 0 && value !== 1)) {
			throw new Error(`Binary feature ${feature.name} contains a value other than 0 or 1`);
		}
	}
	const names = new Set<string>();
	for (const feature of features) {
		if (names.has(feature.name)) throw new Error(`Duplicate feature name: ${feature.name}`);
		names.add(feature.name);
	}
	const folds = createStratifiedFolds(labels, foldCount, seed);
	const results = features.map((feature): FeatureResult => {
		const featureHealth = health(feature.train, nearConstantFraction);
		const usableRows = feature.train.flatMap((value, index) =>
			value !== null && Number.isFinite(value) ? [index] : [],
		);
		const values = usableRows.map((row) => feature.train[row] as number);
		const usableLabels = usableRows.map((row) => labels[row]);
		const rawAuc = auc(feature.train, labels);
		const foldResults = featureHealth.constant ? [] : crossValidatedThreshold(feature.train, labels, folds);
		const binary = feature.kind === "binary"
			? binaryStatistics(values, usableLabels)
			: { class0Prevalence: null, class1Prevalence: null, smoothedLogOdds: null, chiSquare: null };
		const miValues = feature.kind === "numeric" ? discretizeNumeric(values) : values;
		const testHealth = feature.test ? health(feature.test, nearConstantFraction) : null;
		const trainingValues = new Set(values);
		return {
			name: feature.name,
			kind: feature.kind,
			health: featureHealth,
			association: {
				auc: rawAuc === null ? null : Math.max(rawAuc, 1 - rawAuc),
				aucDirection: rawAuc === null ? null : rawAuc >= 0.5 ? "higher" : "lower",
				mutualInformation: mutualInformation(miValues, usableLabels),
				class0Median: median(usableRows.filter((row) => labels[row] === 0).map((row) => feature.train[row] as number)),
				class1Median: median(usableRows.filter((row) => labels[row] === 1).map((row) => feature.train[row] as number)),
				...binary,
				crossValidatedBalancedAccuracy: foldResults.length === 0
					? null
					: foldResults.reduce((sum, result) => sum + result.balancedAccuracy, 0) / foldResults.length,
				folds: foldResults,
			},
			test: feature.test && testHealth ? {
				missing: testHealth.missing,
				nonFinite: testHealth.nonFinite,
				unseenValues: finiteValues(feature.test).filter((value) => !trainingValues.has(value)).length,
			} : null,
		};
	});
	const duplicateColumns: Array<{ first: string; duplicate: string }> = [];
	for (let index = 0; index < features.length; index++) {
		for (let candidate = 0; candidate < index; candidate++) {
			if (columnsEqual(features[index].train, features[candidate].train)) {
				duplicateColumns.push({ first: features[candidate].name, duplicate: features[index].name });
				break;
			}
		}
	}
	return {
		schemaVersion: 1,
		rows: labels.length,
		columns: features.length,
		foldCount,
		seed,
		constantColumns: results.filter((result) => result.health.constant).map((result) => result.name),
		nearConstantColumns: results.filter((result) => result.health.nearConstant).map((result) => result.name),
		duplicateColumns,
		features: results,
	};
}

export function featureAuditToJson(report: FeatureAuditReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

function metric(value: number | null, digits = 4): string {
	return value === null ? "n/a" : value.toFixed(digits);
}

export function featureAuditToMarkdown(report: FeatureAuditReport): string {
	const lines = [
		"# Feature audit",
		"",
		`Rows: ${report.rows}`,
		`Columns: ${report.columns}`,
		`Folds: ${report.foldCount}`,
		"",
		"| Feature | Type | Valid | Missing | Unique | AUC | CV BACC |",
		"|---|---:|---:|---:|---:|---:|---:|",
	];
	for (const feature of report.features) {
		lines.push(`| ${feature.name} | ${feature.kind} | ${feature.health.valid} | ${feature.health.missing + feature.health.nonFinite} | ${feature.health.unique} | ${metric(feature.association.auc)} | ${metric(feature.association.crossValidatedBalancedAccuracy)} |`);
	}
	if (report.constantColumns.length > 0) lines.push("", `Constant columns: ${report.constantColumns.join(", ")}`);
	if (report.duplicateColumns.length > 0) {
		lines.push("", `Duplicate columns: ${report.duplicateColumns.map((pair) => `${pair.duplicate} = ${pair.first}`).join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}
