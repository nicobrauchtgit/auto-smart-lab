import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const SEED_PLAN_VERSION = 1 as const;
export const SEED_DERIVATION = "sha256-domain-separated-uint32-v1" as const;

const UINT32_MAX = 0xffff_ffff;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SeedPlanV1 {
	readonly version: typeof SEED_PLAN_VERSION;
	readonly derivation: typeof SEED_DERIVATION;
	readonly rootSeed: number;
	readonly taskId: string;
	readonly datasetSha256: string;
	readonly experimentId: string;
	/** Stable across experiments for the same root seed, task, and dataset. */
	readonly sealedSeed: number;
	/** Changes with experimentId and is the root of trial-level randomness. */
	readonly experimentSeed: number;
	/** Detects accidental or partial changes to a persisted plan. */
	readonly sha256: string;
}

export type SeedPlan = SeedPlanV1;
export type SeedIdentifier = string | number;

type SeedPlanPayload = Omit<SeedPlanV1, "sha256">;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Hash a structured derivation request instead of concatenating values. The
 * namespace, algorithm version, and domain make seeds from different purposes
 * independent even when all their numeric coordinates happen to match.
 */
function deriveUint32(domain: string, components: readonly (string | number)[]): number {
	const digest = createHash("sha256")
		.update(JSON.stringify({
			namespace: "auto-smart-lab.seed",
			version: SEED_PLAN_VERSION,
			derivation: SEED_DERIVATION,
			domain,
			components,
		}))
		.digest();
	return digest.readUInt32BE(0);
}

function assertUint32(value: unknown, field: string): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
		throw new Error(`${field} must be an unsigned 32-bit integer`);
	}
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

function assertIndex(value: unknown, field: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
}

function assertIdentifier(value: unknown, field: string): asserts value is SeedIdentifier {
	if (typeof value === "number") {
		assertIndex(value, field);
		return;
	}
	assertNonEmptyString(value, field);
}

function payloadSha256(payload: SeedPlanPayload): string {
	return sha256(JSON.stringify(payload));
}

function freezePlan(payload: SeedPlanPayload, planSha256: string): SeedPlanV1 {
	return Object.freeze({ ...payload, sha256: planSha256 });
}

export function createSeedPlan(input: {
	rootSeed: number;
	taskId: string;
	datasetSha256: string;
	experimentId: string;
}): SeedPlanV1 {
	assertUint32(input.rootSeed, "rootSeed");
	assertNonEmptyString(input.taskId, "taskId");
	assertNonEmptyString(input.experimentId, "experimentId");
	if (!SHA256_PATTERN.test(input.datasetSha256)) {
		throw new Error("datasetSha256 must be a lowercase SHA-256 digest");
	}

	const common = [input.rootSeed, input.taskId, input.datasetSha256] as const;
	const payload: SeedPlanPayload = {
		version: SEED_PLAN_VERSION,
		derivation: SEED_DERIVATION,
		rootSeed: input.rootSeed,
		taskId: input.taskId,
		datasetSha256: input.datasetSha256,
		experimentId: input.experimentId,
		sealedSeed: deriveUint32("sealed", common),
		experimentSeed: deriveUint32("experiment", [...common, input.experimentId]),
	};
	return freezePlan(payload, payloadSha256(payload));
}

/** Derive from the recorded experiment seed, never by rebuilding the plan. */
export function deriveTrialSeed(plan: SeedPlan, trial: SeedIdentifier): number {
	assertIdentifier(trial, "trial");
	return deriveUint32("trial", [plan.experimentSeed, trial]);
}

export function deriveRepeatSeed(plan: SeedPlan, trial: SeedIdentifier, repeat: number): number {
	assertIndex(repeat, "repeat");
	return deriveUint32("repeat", [deriveTrialSeed(plan, trial), repeat]);
}

export function deriveFoldSeed(plan: SeedPlan, trial: SeedIdentifier, repeat: number, fold: number): number {
	assertIndex(fold, "fold");
	return deriveUint32("fold", [deriveRepeatSeed(plan, trial, repeat), fold]);
}

export function deriveEstimatorSeed(
	plan: SeedPlan,
	trial: SeedIdentifier,
	repeat: number,
	fold: number,
	estimator = 0,
): number {
	assertIndex(estimator, "estimator");
	return deriveUint32("estimator", [deriveFoldSeed(plan, trial, repeat, fold), estimator]);
}

export function deriveBootstrapSeed(plan: SeedPlan, bootstrap = 0): number {
	assertIndex(bootstrap, "bootstrap");
	return deriveUint32("bootstrap", [plan.experimentSeed, bootstrap]);
}

const PLAN_KEYS = [
	"datasetSha256",
	"derivation",
	"experimentId",
	"experimentSeed",
	"rootSeed",
	"sealedSeed",
	"sha256",
	"taskId",
	"version",
] as const;

export function parseSeedPlan(serialized: string): SeedPlanV1 {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch (error) {
		throw new Error("seed plan is not valid JSON", { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("seed plan must be a JSON object");
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== PLAN_KEYS.length || keys.some((key, index) => key !== PLAN_KEYS[index])) {
		throw new Error("seed plan has missing or unexpected fields");
	}
	if (record.version !== SEED_PLAN_VERSION) throw new Error(`unsupported seed plan version: ${String(record.version)}`);
	if (record.derivation !== SEED_DERIVATION) throw new Error(`unsupported seed derivation: ${String(record.derivation)}`);
	assertUint32(record.rootSeed, "rootSeed");
	assertUint32(record.sealedSeed, "sealedSeed");
	assertUint32(record.experimentSeed, "experimentSeed");
	assertNonEmptyString(record.taskId, "taskId");
	assertNonEmptyString(record.experimentId, "experimentId");
	if (typeof record.datasetSha256 !== "string" || !SHA256_PATTERN.test(record.datasetSha256)) {
		throw new Error("datasetSha256 must be a lowercase SHA-256 digest");
	}
	if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) {
		throw new Error("sha256 must be a lowercase SHA-256 digest");
	}

	const payload: SeedPlanPayload = {
		version: record.version,
		derivation: record.derivation,
		rootSeed: record.rootSeed,
		taskId: record.taskId,
		datasetSha256: record.datasetSha256,
		experimentId: record.experimentId,
		sealedSeed: record.sealedSeed,
		experimentSeed: record.experimentSeed,
	};
	const expected = payloadSha256(payload);
	if (record.sha256 !== expected) throw new Error("seed plan checksum does not match its contents");
	return freezePlan(payload, record.sha256);
}

export function serializeSeedPlan(plan: SeedPlan): string {
	// Parsing our own canonical representation validates hand-constructed plans
	// before they reach durable storage.
	const serialized = `${JSON.stringify(plan, null, 2)}\n`;
	parseSeedPlan(serialized);
	return serialized;
}

export async function readSeedPlan(path: string): Promise<SeedPlanV1> {
	return parseSeedPlan(await readFile(path, "utf8"));
}

/** Write beside the destination, then rename so readers see either plan in full. */
export async function writeSeedPlan(path: string, plan: SeedPlan): Promise<void> {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, serializeSeedPlan(plan), { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}
