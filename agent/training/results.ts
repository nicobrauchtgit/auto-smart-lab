import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parseExperimentRequest } from "./contract.js";
import { deriveTrialSeed, parseSeedPlan, type SeedPlanV1 } from "./seeds.js";
import type { ExperimentRequest } from "./types.js";

const REQUIRED_ARTIFACTS = [
	["training_seed_plan", "seed-plan.json"],
	["training_fold_manifest", "fold-manifest.json"],
	["training_fold_results", "fold-results.jsonl"],
	["training_oof_predictions", "oof_predictions.csv"],
	["training_metrics", "metrics.json"],
	["training_trial_result", "trial-result.json"],
] as const;

export interface TrainingResultError {
	experimentId?: string;
	file?: string;
	code: string;
	message: string;
}

/** Structurally compatible with StageArtifact, with its owning trial retained. */
export interface TrainingArtifact {
	kind: string;
	path: string;
	bytes: number;
	sha256: string;
	experimentId: string;
}

export interface TrainingInvocation {
	schemaVersion: 1 | 2;
	experimentId: string;
	request: ExperimentRequest;
	inputs: Record<string, unknown>;
	seeds: Record<string, unknown>;
	[key: string]: unknown;
}

export interface TrialMetrics {
	balancedAccuracy?: number;
	adjustedRandIndex?: number;
	[key: string]: unknown;
}

export interface TrialResult {
	schemaVersion: 1;
	experimentId: string;
	status: string;
	scope?: string;
	promotionEligible: boolean;
	requestedFolds?: number;
	completedFolds?: number;
	metrics?: TrialMetrics | null;
	[key: string]: unknown;
}

export interface TrainingTrialResult {
	experimentId: string;
	directory: string;
	request?: ExperimentRequest;
	invocation?: TrainingInvocation;
	result?: TrialResult;
	valid: boolean;
	eligible: boolean;
	errors: TrainingResultError[];
	artifacts: TrainingArtifact[];
}

export interface TrainingCollection {
	trials: TrainingTrialResult[];
	/** Set only by `championSelection` (development_selection.ts): the tagged champion. */
	selected?: TrainingTrialResult;
	valid: boolean;
	errors: TrainingResultError[];
	artifacts: TrainingArtifact[];
}

type JsonObject = Record<string, unknown>;

interface LoadedFiles {
	request?: unknown;
	invocation?: unknown;
	seedPlan?: SeedPlanV1;
	manifest?: JsonObject;
	foldResults?: JsonObject[];
	oof?: string;
	metrics?: JsonObject;
	result?: JsonObject;
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("value is not JSON serializable");
	return serialized;
}

function sameJson(left: unknown, right: unknown): boolean {
	try {
		return canonicalJson(left) === canonicalJson(right);
	} catch {
		return false;
	}
}

function error(
	errors: TrainingResultError[],
	experimentId: string | undefined,
	code: string,
	message: string,
	file?: string,
): void {
	errors.push({ experimentId, ...(file === undefined ? {} : { file }), code, message });
}

function parseJson(text: string, file: string, experimentId: string, errors: TrainingResultError[]): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		error(errors, experimentId, "invalid_json", `${file} is not valid JSON: ${detail}`, file);
		return undefined;
	}
}

function parseJsonObject(text: string, file: string, experimentId: string, errors: TrainingResultError[]): JsonObject | undefined {
	const value = parseJson(text, file, experimentId, errors);
	if (value === undefined) return undefined;
	if (!isObject(value)) {
		error(errors, experimentId, "invalid_document", `${file} must contain a JSON object`, file);
		return undefined;
	}
	return value;
}

function parseFoldResults(text: string, experimentId: string, errors: TrainingResultError[]): JsonObject[] | undefined {
	const rows: JsonObject[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].trim().length === 0) continue;
		const value = parseJson(lines[index], "fold-results.jsonl", experimentId, errors);
		if (value === undefined) return undefined;
		if (!isObject(value)) {
			error(errors, experimentId, "invalid_fold_results", `fold-results.jsonl line ${index + 1} must be an object`, "fold-results.jsonl");
			return undefined;
		}
		rows.push(value);
	}
	return rows;
}

function validateManifestChecksum(manifest: JsonObject): boolean {
	if (typeof manifest.sha256 !== "string") return false;
	const { sha256: _checksum, ...payload } = manifest;
	return sha256(canonicalJson(payload)) === manifest.sha256;
}

function foldKey(value: JsonObject): string | undefined {
	return nonNegativeInteger(value.repeat) && nonNegativeInteger(value.fold)
		? `${value.repeat}:${value.fold}`
		: undefined;
}

async function collectTrial(directory: string, experimentId: string): Promise<TrainingTrialResult> {
	const errors: TrainingResultError[] = [];
	const artifacts: TrainingArtifact[] = [];
	const loaded: LoadedFiles = {};
	const missingArtifacts = new Set<string>();

	const read = async (
		file: string,
		requiredArtifact?: string,
		deferMissing = false,
	): Promise<Buffer | undefined> => {
		const path = join(directory, file);
		try {
			const bytes = await readFile(path);
			if (requiredArtifact !== undefined) {
				artifacts.push({
					kind: requiredArtifact,
					path,
					bytes: bytes.byteLength,
					sha256: sha256(bytes),
					experimentId,
				});
			}
			return bytes;
		} catch (cause) {
			const systemError = cause as NodeJS.ErrnoException;
			if (systemError.code === "ENOENT" && deferMissing) {
				missingArtifacts.add(file);
				return undefined;
			}
			const code = systemError.code === "ENOENT" ? "missing_file" : "unreadable_file";
			const detail = systemError.code === "ENOENT" ? "is missing" : `could not be read: ${systemError.message}`;
			error(errors, experimentId, code, `${file} ${detail}`, file);
			return undefined;
		}
	};

	const requestBytes = await read("request.json");
	if (requestBytes !== undefined) {
		const raw = parseJson(requestBytes.toString("utf8"), "request.json", experimentId, errors);
		if (raw !== undefined) {
			try {
				loaded.request = parseExperimentRequest(raw);
			} catch (cause) {
				error(errors, experimentId, "invalid_request", `request.json is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, "request.json");
			}
		}
	}

	const invocationBytes = await read("invocation.json");
	if (invocationBytes !== undefined) loaded.invocation = parseJsonObject(invocationBytes.toString("utf8"), "invocation.json", experimentId, errors);

	for (const [kind, file] of REQUIRED_ARTIFACTS) {
		const bytes = await read(file, kind, true);
		if (bytes === undefined) continue;
		const text = bytes.toString("utf8");
		if (file === "seed-plan.json") {
			try {
				loaded.seedPlan = parseSeedPlan(text);
			} catch (cause) {
				error(errors, experimentId, "invalid_seed_plan", `seed-plan.json is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, file);
			}
		} else if (file === "fold-manifest.json") {
			loaded.manifest = parseJsonObject(text, file, experimentId, errors);
		} else if (file === "fold-results.jsonl") {
			loaded.foldResults = parseFoldResults(text, experimentId, errors);
		} else if (file === "oof_predictions.csv") {
			loaded.oof = text;
		} else if (file === "metrics.json") {
			loaded.metrics = parseJsonObject(text, file, experimentId, errors);
		} else if (file === "trial-result.json") {
			loaded.result = parseJsonObject(text, file, experimentId, errors);
		}
	}

	let request: ExperimentRequest | undefined;
	if (loaded.request !== undefined) request = loaded.request as ExperimentRequest;

	let invocation: TrainingInvocation | undefined;
	if (loaded.invocation !== undefined) {
		const raw = loaded.invocation as JsonObject;
		let invocationRequest: ExperimentRequest | undefined;
		try {
			invocationRequest = parseExperimentRequest(raw.request);
		} catch (cause) {
			error(errors, experimentId, "invalid_invocation", `invocation.json request is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, "invocation.json");
		}
		if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || typeof raw.experimentId !== "string" || !isObject(raw.inputs) || !isObject(raw.seeds)) {
			error(errors, experimentId, "invalid_invocation", "invocation.json has an invalid schema, identity, inputs, or seeds", "invocation.json");
		} else if (invocationRequest !== undefined) {
			invocation = { ...raw, schemaVersion: raw.schemaVersion, experimentId: raw.experimentId, request: invocationRequest, inputs: raw.inputs, seeds: raw.seeds };
		}
	}

	let result: TrialResult | undefined;
	if (loaded.result !== undefined) {
		const raw = loaded.result;
		if (raw.schemaVersion !== 1 || typeof raw.experimentId !== "string" || typeof raw.status !== "string" || typeof raw.promotionEligible !== "boolean") {
			error(errors, experimentId, "invalid_result", "trial-result.json has an invalid schema, identity, status, or promotionEligible value", "trial-result.json");
		} else {
			result = raw as unknown as TrialResult;
		}
	}

	// Terminal outputs are state-dependent. A failed worker cannot have folds,
	// and a graceful stop before its first fit intentionally has neither fold
	// results nor OOF rows. Completed trials must have the full evidence set.
	const alwaysRequired = new Set(["seed-plan.json", "trial-result.json"]);
	let stateRequired: readonly string[];
	if (result?.status === "failed") {
		stateRequired = [];
	} else if (result?.status === "interrupted" || result?.status === "partial") {
		stateRequired = [
			"fold-manifest.json",
			"metrics.json",
			...(nonNegativeInteger(result.completedFolds) && result.completedFolds > 0
				? ["fold-results.jsonl", "oof_predictions.csv"]
				: []),
		];
	} else {
		stateRequired = REQUIRED_ARTIFACTS.map(([, file]) => file);
	}
	for (const file of new Set([...alwaysRequired, ...stateRequired])) {
		if (missingArtifacts.has(file)) error(errors, experimentId, "missing_file", `${file} is missing`, file);
	}

	const identities: [string, unknown][] = [
		["invocation.json", invocation?.experimentId],
		["seed-plan.json", loaded.seedPlan?.experimentId],
		["fold-manifest.json", loaded.manifest?.experimentId],
		["metrics.json", loaded.metrics?.experimentId],
		["trial-result.json", result?.experimentId],
	];
	for (const [file, identity] of identities) {
		if (identity !== undefined && identity !== experimentId) {
			error(errors, experimentId, "identity_mismatch", `${file} experimentId ${JSON.stringify(identity)} does not match directory ${JSON.stringify(experimentId)}`, file);
		}
	}
	for (const [index, fold] of (loaded.foldResults ?? []).entries()) {
		if (fold.experimentId !== experimentId) {
			error(errors, experimentId, "identity_mismatch", `fold-results.jsonl line ${index + 1} does not match experiment ${JSON.stringify(experimentId)}`, "fold-results.jsonl");
		}
	}

	if (request !== undefined && invocation !== undefined && !sameJson(request, invocation.request)) {
		error(errors, experimentId, "request_mismatch", "request.json and invocation.json request do not match", "invocation.json");
	}
	if (invocation !== undefined) {
		const outputDir = invocation.inputs.outputDir;
		if (typeof outputDir !== "string" || resolve(outputDir) !== directory) {
			error(errors, experimentId, "identity_mismatch", "invocation.json inputs.outputDir does not match the experiment directory", "invocation.json");
		}
	}
	if (loaded.seedPlan !== undefined && invocation !== undefined) {
		if (invocation.seeds.experiment !== loaded.seedPlan.experimentSeed || invocation.seeds.trial !== deriveTrialSeed(loaded.seedPlan, 0)) {
			error(errors, experimentId, "seed_mismatch", "invocation.json seeds do not match seed-plan.json", "invocation.json");
		}
	}

	if (loaded.manifest !== undefined) {
		if (!validateManifestChecksum(loaded.manifest)) {
			error(errors, experimentId, "integrity_mismatch", "fold-manifest.json checksum does not match its contents", "fold-manifest.json");
		}
		if (!nonNegativeInteger(loaded.manifest.foldCount) || !Array.isArray(loaded.manifest.folds) || loaded.manifest.folds.length !== loaded.manifest.foldCount) {
			error(errors, experimentId, "invalid_manifest", "fold-manifest.json foldCount does not match its folds", "fold-manifest.json");
		}
		if (loaded.seedPlan !== undefined && invocation !== undefined && loaded.manifest.seed !== invocation.seeds.trial) {
			error(errors, experimentId, "seed_mismatch", "fold-manifest.json seed does not match the invocation trial seed", "fold-manifest.json");
		}
		if (result !== undefined && result.manifestSha256 !== loaded.manifest.sha256) {
			error(errors, experimentId, "integrity_mismatch", "trial-result.json manifestSha256 does not match fold-manifest.json", "trial-result.json");
		}
	}

	const scope = request?.scope.kind;
	for (const [file, observed] of [
		["fold-manifest.json", loaded.manifest?.scope],
		["metrics.json", loaded.metrics?.scope],
		["trial-result.json", result?.scope],
	] as const) {
		if (scope !== undefined && observed !== undefined && observed !== scope) {
			error(errors, experimentId, "scope_mismatch", `${file} scope ${JSON.stringify(observed)} does not match request scope ${JSON.stringify(scope)}`, file);
		}
	}

	if (loaded.metrics !== undefined && result !== undefined && !sameJson(loaded.metrics, result)) {
		error(errors, experimentId, "result_mismatch", "metrics.json and trial-result.json do not match", "metrics.json");
	}

	const foldRows = loaded.foldResults;
	const requestedFolds = result?.requestedFolds;
	const completedFolds = result?.completedFolds;
	if (result !== undefined && (!nonNegativeInteger(requestedFolds) || !nonNegativeInteger(completedFolds) || completedFolds > requestedFolds)) {
		error(errors, experimentId, "invalid_result", "trial-result.json requestedFolds/completedFolds are invalid", "trial-result.json");
	}
	if (foldRows !== undefined && nonNegativeInteger(completedFolds) && foldRows.length !== completedFolds) {
		error(errors, experimentId, "fold_count_mismatch", `fold-results.jsonl has ${foldRows.length} rows but trial-result.json reports ${completedFolds} completed folds`, "fold-results.jsonl");
	}
	if (loaded.manifest !== undefined && nonNegativeInteger(requestedFolds) && loaded.manifest.foldCount !== requestedFolds) {
		error(errors, experimentId, "fold_count_mismatch", "fold-manifest.json foldCount does not match trial-result.json requestedFolds", "fold-manifest.json");
	}
	if (foldRows !== undefined && Array.isArray(loaded.manifest?.folds)) {
		const expected = new Set((loaded.manifest.folds as unknown[]).filter(isObject).map(foldKey).filter((key): key is string => key !== undefined));
		const observed = foldRows.map(foldKey);
		if (observed.some((key) => key === undefined) || new Set(observed).size !== observed.length || observed.some((key) => !expected.has(key!))) {
			error(errors, experimentId, "fold_identity_mismatch", "fold-results.jsonl repeat/fold identities do not match the manifest", "fold-results.jsonl");
		}
	}

	if (loaded.oof !== undefined) {
		const header = loaded.oof.split(/\r?\n/, 1)[0]?.split(";") ?? [];
		if (header.length < 4 || header[0] !== "id" || header[1] !== "repeat" || header[2] !== "fold" || header[3] !== "prediction") {
			error(errors, experimentId, "invalid_oof_predictions", "oof_predictions.csv has an invalid header", "oof_predictions.csv");
		}
	}

	const measurement = invocation?.measurement as { kind?: string; hasTargets?: boolean; sampleManifestSha256?: string; sampleManifestPath?: string; evidence?: { path: string; source: string }; evidenceManifestSha256?: string; selection?: { basis: string; metric: string; direction: string; population: string } } | undefined;
	const clustering = measurement?.kind === "clustering";
	const evidenceSelection = measurement?.kind === "anomaly_detection" && measurement.selection !== undefined;
	const unlabelled = (measurement?.kind === "anomaly_detection" && !evidenceSelection) || (clustering && measurement.hasTargets !== true);
	const balancedAccuracy = evidenceSelection ? result?.metrics?.selectionScore : clustering ? result?.metrics?.adjustedRandIndex : result?.metrics?.balancedAccuracy;
	if (result?.metrics !== null && result?.metrics !== undefined
		&& (!finiteNumber(balancedAccuracy) || balancedAccuracy < (clustering ? -1 : 0) || balancedAccuracy > 1)) {
		error(errors, experimentId, "invalid_result", `trial-result.json primary metric must be between ${clustering ? -1 : 0} and 1`, "trial-result.json");
	}
	if (measurement && result?.status !== "failed") {
		if (!["classification", "clustering", "anomaly_detection"].includes(measurement.kind ?? "") || typeof measurement.hasTargets !== "boolean"
			|| typeof measurement.sampleManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(measurement.sampleManifestSha256)) {
			error(errors, experimentId, "invalid_measurement", "Controller measurement lacks validated kind, target availability or metadata hash", "invocation.json");
		}
		if (result?.measurementKind !== measurement.kind || !sameJson(result?.measurement, invocation?.measurement)) {
			error(errors, experimentId, "measurement_mismatch", "Trial measurement differs from the controller invocation", "trial-result.json");
		}
		if (!isObject(result?.diagnostics) || result.diagnostics.kind !== measurement.kind) {
			error(errors, experimentId, "invalid_diagnostics", "Task diagnostics are missing or have the wrong measurement kind", "trial-result.json");
		}
	}

	if (evidenceSelection && result?.status !== "failed") {
		const selection = measurement!.selection!;
		if (selection.basis !== "evidence" || !["evidence_average_precision", "evidence_roc_auc"].includes(selection.metric)
			|| selection.direction !== "maximize" || selection.population !== "development")
			error(errors, experimentId, "invalid_selection", "Invalid explicit evidence selection contract", "invocation.json");
		if (resolve(measurement!.evidence?.path ?? "") !== join(directory, "evidence.json")) {
			error(errors, experimentId, "invalid_evidence", "Evidence must be the trial-owned snapshot", "invocation.json");
		} else {
			const bytes = await read("evidence.json", "training_selection_evidence");
			if (bytes && sha256(bytes) !== measurement!.evidenceManifestSha256)
				error(errors, experimentId, "integrity_mismatch", "Evidence snapshot hash changed", "evidence.json");
			if (bytes && loaded.oof && foldRows) {
				try {
					const evidence = JSON.parse(bytes.toString("utf8"));
					if (evidence.schemaVersion !== 1 || Object.keys(evidence).sort().join() !== "labels,schemaVersion" || !Array.isArray(evidence.labels) || !evidence.labels.length) throw new Error("Invalid evidence labels");
					const labels = new Map<string, number>();
					const sampleBytes = await readFile(String(measurement!.sampleManifestPath));
                    if (sha256(sampleBytes) !== measurement!.sampleManifestSha256) throw new Error("Development sample manifest changed");
                    const known = new Set(JSON.parse(sampleBytes.toString("utf8")).samples.map((row: any) => row.id));
					for (const row of evidence.labels) {
						if (Object.keys(row).sort().join() !== "id,target" || !known.has(row.id) || labels.has(row.id) || ![0, 1].includes(row.target)) throw new Error("Invalid or unknown evidence ID/target");
						labels.set(row.id, row.target);
					}
					const observations = loaded.oof.trim().split(/\r?\n/).slice(1).map(line => line.split(";"));
                    const completedKeys = new Set(foldRows.map(foldKey));
                    const expected = (loaded.manifest?.assignments as JsonObject[] ?? []).filter(row => completedKeys.has(foldKey(row)));
                    const key = (row: unknown[]) => JSON.stringify([row[0], Number(row[1]), Number(row[2])]);
                    const observedKeys = observations.map(key);
                    const expectedKeys = expected.map(row => JSON.stringify([row.id, row.repeat, row.fold]));
                    if (observedKeys.length !== expectedKeys.length || new Set(observedKeys).size !== observedKeys.length || !sameJson([...observedKeys].sort(), [...expectedKeys].sort())) throw new Error("OOF evidence rows do not match completed manifest folds");
                    if (observations.some(row => row[3] === "" || !Number.isInteger(Number(row[3])))) throw new Error("Selection requires integer predictions");
					for (const fold of foldRows) {
						const rows = observations.filter(row => Number(row[1]) === fold.repeat && Number(row[2]) === fold.fold && labels.has(row[0]));
						const scores = rows.map(row => ({ truth: labels.get(row[0])!, score: Number(row[4]) * ((measurement as any).scoreDirection === "lower_is_anomalous" ? -1 : 1) }));
						if (rows.some(row => !row[4] || !Number.isFinite(Number(row[4])))) throw new Error("Non-finite or missing evidence scores");
						const classes = new Set(scores.map(row => row.truth));
						const receipt = fold.selection as Record<string, unknown> | undefined;
						if (receipt?.evidenceSha256 !== measurement!.evidenceManifestSha256 || receipt?.metric !== selection.metric || receipt?.source !== measurement!.evidence?.source
                            || receipt?.basis !== selection.basis || receipt?.direction !== selection.direction || receipt?.population !== selection.population
                            || receipt?.labelledRows !== rows.length || receipt?.positiveRows !== scores.filter(row => row.truth === 1).length
                            || receipt?.negativeRows !== scores.filter(row => row.truth === 0).length
                            || receipt?.validationRows !== fold.validationRows || receipt?.labelCoverage !== rows.length / Number(fold.validationRows)) throw new Error("Fold selection identity mismatch");
						if (classes.size !== 2) {
							if (receipt.available === true || (fold.metrics as any)?.selectionScore !== undefined || result?.promotionEligible) throw new Error("One-class evidence fold cannot select or promote");
							continue;
						}
						const expected = evidenceRanking(scores, selection.metric);
						if (!finiteNumber(receipt.value) || !finiteNumber((fold.metrics as any)?.selectionScore) || receipt.available !== true || Math.abs(Number(receipt.value) - expected) > 1e-10 || Math.abs(Number((fold.metrics as any)?.selectionScore) - expected) > 1e-10) throw new Error("Recomputed fold selection score differs");
					}
					const usable = foldRows.every(fold => finiteNumber((fold.metrics as any)?.selectionScore));
					if (usable && foldRows.length && (!finiteNumber(balancedAccuracy) || Math.abs(Number(balancedAccuracy) - foldRows.reduce((sum, fold) => sum + Number((fold.metrics as any).selectionScore), 0) / foldRows.length) > 1e-10)) throw new Error("Recomputed selection mean differs");
                    const summarySelection = result?.selection as Record<string, unknown> | undefined;
                    if (summarySelection?.basis !== selection.basis || summarySelection.metric !== selection.metric || summarySelection.direction !== selection.direction || summarySelection.population !== selection.population
                        || summarySelection.evidenceSha256 !== measurement!.evidenceManifestSha256 || summarySelection.source !== measurement!.evidence?.source
                        || !sameJson(summarySelection.folds, foldRows.map(fold => fold.selection))) throw new Error("Selection summary identity/receipts differ");
				} catch (cause) { error(errors, experimentId, "invalid_selection_evidence", String(cause), "evidence.json"); }
			}
		}
	}

	// A search winner was selected on the folds that scored it; only a
	// confirmation trial on a fresh manifest can become eligible.
	const isSearch = request?.search !== undefined || invocation?.request.search !== undefined;
	if (isSearch && result?.status !== "failed") {
		for (const [kind, file] of [["training_search_configs", "configs.jsonl"], ["training_search_report", "search-report.json"],
			["training_search_journal", "study.journal"]]) {
			const bytes = await read(file, kind);
			if (file === "search-report.json" && bytes) {
				const report = parseJsonObject(bytes.toString("utf8"), file, experimentId, errors);
				if (report?.experimentId !== experimentId || report?.manifestSha256 !== loaded.manifest?.sha256) {
					error(errors, experimentId, "identity_mismatch", "search report identity/manifest differs from the trial", file);
				}
				for (const key of ["leaderboard", "parameterImportance", "parameterEffects", "comparison", "progress", "cost", "caveats", "nextStep"]) {
					if (report?.[key] === undefined) error(errors, experimentId, "invalid_search_report", `search report is missing ${key}`, file);
				}
			}
		}
		await read("oof_runner_up.csv", "training_search_runner_up", true);
	}
	if (isSearch && result?.promotionEligible === true) {
		error(errors, experimentId, "invalid_promotion_eligibility", "a search trial is never promotion-eligible", "trial-result.json");
	}
	const completePromotion = !unlabelled && !isSearch && scope === "promotion"
		&& result?.scope === "promotion"
		&& result.status === "completed"
		&& nonNegativeInteger(requestedFolds)
		&& requestedFolds > 0
		&& completedFolds === requestedFolds
		&& foldRows?.length === requestedFolds
		&& loaded.manifest?.foldCount === requestedFolds
		&& finiteNumber(balancedAccuracy);
	if (result?.promotionEligible === true && !completePromotion) {
		error(errors, experimentId, "invalid_promotion_eligibility", "promotionEligible is true without a completed promotion and all requested folds", "trial-result.json");
	}

	if (result?.promotionEligible === true && (result.idLeakage || foldRows?.some(fold => fold.idLeakage))) {
		error(errors, experimentId, "invalid_promotion_eligibility", "ID leakage evidence cannot be promotion-eligible", "trial-result.json");
	}

	const valid = errors.length === 0;
	return {
		experimentId,
		directory,
		...(request === undefined ? {} : { request }),
		...(invocation === undefined ? {} : { invocation }),
		...(result === undefined ? {} : { result }),
		valid,
		eligible: valid && result?.promotionEligible === true && completePromotion,
		errors,
		artifacts,
	};
}

/**
 * Validate durable harness evidence without allowing one damaged experiment to
 * hide the other completed, partial, or pilot trials beside it.
 */
export async function collectTrainingResults(root: string): Promise<TrainingCollection> {
	const trainingRoot = resolve(root);
	let entries;
	try {
		entries = await readdir(trainingRoot, { withFileTypes: true });
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		const errors: TrainingResultError[] = [{ code: "unreadable_root", message: `training root could not be read: ${detail}` }];
		return { trials: [], valid: false, errors, artifacts: [] };
	}

	const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	const trials: TrainingTrialResult[] = [];
	for (const experimentId of directories) {
		trials.push(await collectTrial(join(trainingRoot, experimentId), experimentId));
	}

	// No selection here: the champion tag is the only selection rule
	// (`championSelection`); a higher raw CV mean alone selects nothing.
	const eligible = trials.some((trial) => trial.eligible);
	const errors = trials.flatMap((trial) => trial.errors);
	if (!eligible) {
		error(errors, undefined, "no_eligible_result", "no valid completed promotion is eligible for selection");
	}
	return {
		trials,
		// Invalid historical trials remain evidence, but do not veto a separate
		// promotion whose own artifacts and eligibility validate cleanly.
		valid: eligible,
		errors,
		artifacts: trials.flatMap((trial) => trial.artifacts),
	};
}

/** Validate one controller-selected durable trial without scanning unrelated runs. */
export async function collectTrainingTrial(directory: string): Promise<TrainingTrialResult> {
	const path = resolve(directory);
	return collectTrial(path, basename(path));
}

/** Ranking metrics with score ties handled as one threshold, matching sklearn. */
function evidenceRanking(rows: { truth: number; score: number }[], metric: string): number {
 const positives = rows.filter(row => row.truth === 1).length;
 const negatives = rows.length - positives;
 rows.sort((a, b) => b.score - a.score);
 let tp = 0, fp = 0, ap = 0, auc = 0;
 for (let i = 0; i < rows.length;) {
  let end = i + 1;
  while (end < rows.length && rows[end].score === rows[i].score) end++;
  const oldTp = tp, oldFp = fp;
  for (; i < end; i++) { if (rows[i].truth) tp++; else fp++; }
  ap += (tp - oldTp) / positives * tp / (tp + fp);
  auc += (fp - oldFp) / negatives * (tp + oldTp) / (2 * positives);
 }
 return metric === "evidence_average_precision" ? ap : auc;
}
