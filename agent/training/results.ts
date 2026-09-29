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
	schemaVersion: 1;
	experimentId: string;
	request: ExperimentRequest;
	inputs: Record<string, unknown>;
	seeds: Record<string, unknown>;
	[key: string]: unknown;
}

export interface TrialMetrics {
	balancedAccuracy: number;
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
		requiredArtifact?: (typeof REQUIRED_ARTIFACTS)[number][0],
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
		if (raw.schemaVersion !== 1 || typeof raw.experimentId !== "string" || !isObject(raw.inputs) || !isObject(raw.seeds)) {
			error(errors, experimentId, "invalid_invocation", "invocation.json has an invalid schema, identity, inputs, or seeds", "invocation.json");
		} else if (invocationRequest !== undefined) {
			invocation = { ...raw, schemaVersion: 1, experimentId: raw.experimentId, request: invocationRequest, inputs: raw.inputs, seeds: raw.seeds };
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

	const balancedAccuracy = result?.metrics?.balancedAccuracy;
	if (result?.metrics !== null && result?.metrics !== undefined
		&& (!finiteNumber(balancedAccuracy) || balancedAccuracy < 0 || balancedAccuracy > 1)) {
		error(errors, experimentId, "invalid_result", "trial-result.json metrics.balancedAccuracy must be between 0 and 1", "trial-result.json");
	}

	const completePromotion = scope === "promotion"
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

	const eligible = trials.filter((trial) => trial.eligible).sort((left, right) => {
		const scoreDifference = right.result!.metrics!.balancedAccuracy - left.result!.metrics!.balancedAccuracy;
		if (scoreDifference !== 0) return scoreDifference;
		return left.experimentId < right.experimentId ? -1 : left.experimentId > right.experimentId ? 1 : 0;
	});
	const selected = eligible[0];
	const errors = trials.flatMap((trial) => trial.errors);
	if (selected === undefined) {
		error(errors, undefined, "no_eligible_result", "no valid completed promotion is eligible for selection");
	}
	return {
		trials,
		...(selected === undefined ? {} : { selected }),
		// Invalid historical trials remain evidence, but do not veto a separate
		// promotion whose own artifacts and eligibility validate cleanly.
		valid: selected !== undefined,
		errors,
		artifacts: trials.flatMap((trial) => trial.artifacts),
	};
}
