import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createSeedPlan,
	deriveBootstrapSeed,
	deriveEstimatorSeed,
	deriveFoldSeed,
	deriveRepeatSeed,
	deriveTrialSeed,
	parseSeedPlan,
	readSeedPlan,
	serializeSeedPlan,
	writeSeedPlan,
} from "./seeds.js";

const DATASET_SHA256 = "a".repeat(64);
const directories: string[] = [];

function plan(experimentId = "experiment-a") {
	return createSeedPlan({
		rootSeed: 42,
		taskId: "spam1",
		datasetSha256: DATASET_SHA256,
		experimentId,
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("seed plan derivation", () => {
	test("is deterministic and keeps every seed in uint32 bounds", () => {
		const first = plan();
		const again = plan();
		expect(again).toEqual(first);
		expect(first).toMatchObject({
			sealedSeed: 1_399_109_402,
			experimentSeed: 2_660_019_233,
			sha256: "d4a4c168a2ba2525f350bc06c6307e386cf3eed87503b386bbaab901a4b212c7",
		});

		const seeds = [
			first.sealedSeed,
			first.experimentSeed,
			deriveTrialSeed(first, "trial-a"),
			deriveRepeatSeed(first, "trial-a", 0),
			deriveFoldSeed(first, "trial-a", 0, 0),
			deriveEstimatorSeed(first, "trial-a", 0, 0),
			deriveBootstrapSeed(first, 0),
		];
		for (const seed of seeds) {
			expect(Number.isInteger(seed)).toBe(true);
			expect(seed).toBeGreaterThanOrEqual(0);
			expect(seed).toBeLessThanOrEqual(0xffff_ffff);
		}
	});

	test("domain-separates trial, repeat, fold, estimator, and bootstrap seeds", () => {
		const value = plan();
		const seeds = new Set([
			deriveTrialSeed(value, 0),
			deriveRepeatSeed(value, 0, 0),
			deriveFoldSeed(value, 0, 0, 0),
			deriveEstimatorSeed(value, 0, 0, 0, 0),
			deriveBootstrapSeed(value, 0),
		]);
		expect(seeds.size).toBe(5);
	});

	test("keeps the sealed seed stable while varying the experiment seed", () => {
		const first = plan("experiment-a");
		const second = plan("experiment-b");
		expect(second.sealedSeed).toBe(first.sealedSeed);
		expect(second.experimentSeed).not.toBe(first.experimentSeed);
	});

	test("validates input coordinates", () => {
		expect(() => createSeedPlan({ rootSeed: -1, taskId: "spam1", datasetSha256: DATASET_SHA256, experimentId: "x" })).toThrow();
		expect(() => deriveFoldSeed(plan(), "trial", 0, -1)).toThrow();
		expect(() => deriveTrialSeed(plan(), "")).toThrow();
	});
});

describe("seed plan persistence", () => {
	test("round-trips strict serialization and durable storage", async () => {
		const expected = plan();
		expect(parseSeedPlan(serializeSeedPlan(expected))).toEqual(expected);

		const directory = await mkdtemp(join(tmpdir(), "seed-plan-"));
		directories.push(directory);
		const path = join(directory, "seed-plan.json");
		await writeSeedPlan(path, expected);
		expect(await readSeedPlan(path)).toEqual(expected);
		expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
	});

	test("rejects malformed, incomplete, extended, and corrupted plans", () => {
		expect(() => parseSeedPlan("{")).toThrow("not valid JSON");
		expect(() => parseSeedPlan("[]")).toThrow("JSON object");

		const valid = JSON.parse(serializeSeedPlan(plan())) as Record<string, unknown>;
		const missing = { ...valid };
		delete missing.experimentId;
		expect(() => parseSeedPlan(JSON.stringify(missing))).toThrow("missing or unexpected");
		expect(() => parseSeedPlan(JSON.stringify({ ...valid, extra: true }))).toThrow("missing or unexpected");
		expect(() => parseSeedPlan(JSON.stringify({ ...valid, experimentSeed: 7 }))).toThrow("checksum");
		expect(() => parseSeedPlan(JSON.stringify({ ...valid, sealedSeed: -1 }))).toThrow("unsigned 32-bit");
	});
});
