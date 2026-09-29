import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSeedPlan, deriveTrialSeed, serializeSeedPlan } from "./seeds.js";
import { collectTrainingResults } from "./results.js";
import type { ExperimentRequest } from "./types.js";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface TrialFixtureOptions {
	scope?: "pilot" | "promotion";
	score?: number;
	status?: "completed" | "partial" | "interrupted";
	promotionEligible?: boolean;
	requestedFolds?: number;
	completedFolds?: number;
}

async function writeTrial(root: string, id: string, options: TrialFixtureOptions = {}): Promise<string> {
	const directory = join(root, id);
	await mkdir(directory, { recursive: true });
	const scope = options.scope ?? "promotion";
	const requestedFolds = options.requestedFolds ?? 2;
	const completedFolds = options.completedFolds ?? requestedFolds;
	const status = options.status ?? "completed";
	const promotionEligible = options.promotionEligible ?? (scope === "promotion" && status === "completed" && completedFolds === requestedFolds);
	const request: ExperimentRequest = {
		schemaVersion: 1,
		hypothesis: `${id} hypothesis`,
		pipeline: { module: "solutions/tasks/task.py", factory: "build_pipeline", parameters: { id } },
		cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
		scope: scope === "promotion" ? { kind: "promotion" } : { kind: "pilot", maxFolds: 2 },
	};
	const plan = createSeedPlan({ rootSeed: 13, taskId: "task", datasetSha256: "a".repeat(64), experimentId: id });
	const trialSeed = deriveTrialSeed(plan, 0);
	const folds = Array.from({ length: requestedFolds }, (_, fold) => ({
		repeat: 0,
		fold,
		seed: fold + 100,
		trainIndices: [fold === 0 ? 1 : 0],
		validationIndices: [fold],
	}));
	const manifestPayload = {
		schemaVersion: 1,
		experimentId: id,
		scope,
		seed: trialSeed,
		rowCount: 2,
		foldCount: requestedFolds,
		assignments: folds.map((fold) => ({ id: `row-${fold.fold}`, index: fold.fold, repeat: 0, fold: fold.fold })),
		folds,
	};
	const manifest = { ...manifestPayload, sha256: digest(canonical(manifestPayload)) };
	const metrics = {
		schemaVersion: 1,
		experimentId: id,
		status,
		scope,
		promotionEligible,
		requestedFolds,
		completedFolds,
		rows: 2,
		manifestSha256: manifest.sha256,
		durationSeconds: 1,
		metrics: completedFolds === 0 ? null : {
			balancedAccuracy: options.score ?? 0.75,
			perClassRecall: { "0": 0.5, "1": 1 },
			confusionMatrix: [[1, 1], [0, 2]],
			labels: [0, 1],
		},
	};
	const foldResults = folds.slice(0, completedFolds).map((fold) => JSON.stringify({
		schemaVersion: 1,
		experimentId: id,
		repeat: fold.repeat,
		fold: fold.fold,
		seed: fold.seed,
		trainRows: 1,
		validationRows: 1,
		durationSeconds: 0.1,
		seededParameters: {},
		metrics: { balancedAccuracy: 1 },
	})).join("\n") + "\n";
	const invocation = {
		schemaVersion: 1,
		experimentId: id,
		request,
		inputs: { projectRoot: root, zipPath: "train.zip", labelsPath: "train.labels", outputDir: directory },
		seeds: { experiment: plan.experimentSeed, trial: trialSeed },
	};
	await Promise.all([
		writeFile(join(directory, "request.json"), `${JSON.stringify(request, null, 2)}\n`),
		writeFile(join(directory, "invocation.json"), `${JSON.stringify(invocation, null, 2)}\n`),
		writeFile(join(directory, "seed-plan.json"), serializeSeedPlan(plan)),
		writeFile(join(directory, "fold-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
		writeFile(join(directory, "fold-results.jsonl"), foldResults),
		writeFile(join(directory, "oof_predictions.csv"), "id;repeat;fold;prediction;score\nrow-0;0;0;0;0.1\nrow-1;0;1;1;0.9\n"),
		writeFile(join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`),
		writeFile(join(directory, "trial-result.json"), `${JSON.stringify(metrics, null, 2)}\n`),
	]);
	return directory;
}

describe("collectTrainingResults", () => {
	test("keeps pilots visible and deterministically selects the best completed promotion", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		await writeTrial(root, "pilot", { scope: "pilot", score: 1, promotionEligible: false });
		await writeTrial(root, "z-promotion", { score: 0.91 });
		await writeTrial(root, "a-promotion", { score: 0.91 });
		await writeTrial(root, "lower-promotion", { score: 0.82 });

		const collection = await collectTrainingResults(root);

		expect(collection.valid).toBe(true);
		expect(collection.errors).toEqual([]);
		expect(collection.trials.map((trial) => trial.experimentId)).toEqual([
			"a-promotion", "lower-promotion", "pilot", "z-promotion",
		]);
		expect(collection.trials.find((trial) => trial.experimentId === "pilot")?.eligible).toBe(false);
		expect(collection.selected?.experimentId).toBe("a-promotion");
		expect(collection.selected?.request?.scope.kind).toBe("promotion");
		expect(collection.selected?.result?.metrics?.balancedAccuracy).toBe(0.91);
	});

	test("returns hashes and byte sizes for every authoritative artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		await writeTrial(root, "promotion");

		const collection = await collectTrainingResults(root);

		expect(collection.artifacts).toHaveLength(6);
		expect(collection.trials[0].artifacts).toEqual(collection.artifacts);
		expect(collection.artifacts.map((artifact) => artifact.kind)).toEqual([
			"training_seed_plan",
			"training_fold_manifest",
			"training_fold_results",
			"training_oof_predictions",
			"training_metrics",
			"training_trial_result",
		]);
		for (const artifact of collection.artifacts) {
			expect(artifact.experimentId).toBe("promotion");
			expect(artifact.bytes).toBeGreaterThan(0);
			expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(artifact.path).toStartWith(join(root, "promotion"));
		}
	});

	test("reports corrupt and missing trials without erasing valid evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		await writeTrial(root, "good", { score: 0.8 });
		const corrupt = await writeTrial(root, "corrupt", { score: 0.99 });
		await writeFile(join(corrupt, "trial-result.json"), "{not-json\n");
		const missing = await writeTrial(root, "missing", { score: 1 });
		await Bun.file(join(missing, "oof_predictions.csv")).delete();

		const collection = await collectTrainingResults(root);

		expect(collection.valid).toBe(true);
		expect(collection.selected?.experimentId).toBe("good");
		expect(collection.trials).toHaveLength(3);
		expect(collection.trials.find((trial) => trial.experimentId === "corrupt")?.errors)
			.toContainEqual(expect.objectContaining({ code: "invalid_json", file: "trial-result.json" }));
		expect(collection.trials.find((trial) => trial.experimentId === "missing")?.errors)
			.toContainEqual(expect.objectContaining({ code: "missing_file", file: "oof_predictions.csv" }));
		expect(collection.artifacts.some((artifact) => artifact.experimentId === "good")).toBe(true);
		expect(collection.artifacts.some((artifact) => artifact.experimentId === "corrupt" && artifact.kind === "training_trial_result")).toBe(true);
	});

	test("rejects inconsistent identity, scope, seeds, and manifest integrity", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		const directory = await writeTrial(root, "tampered");
		const result = await Bun.file(join(directory, "trial-result.json")).json();
		result.experimentId = "another-id";
		result.scope = "pilot";
		await writeFile(join(directory, "trial-result.json"), `${JSON.stringify(result)}\n`);
		const invocation = await Bun.file(join(directory, "invocation.json")).json();
		invocation.seeds.trial++;
		await writeFile(join(directory, "invocation.json"), `${JSON.stringify(invocation)}\n`);
		const manifest = await Bun.file(join(directory, "fold-manifest.json")).json();
		manifest.rowCount++;
		await writeFile(join(directory, "fold-manifest.json"), `${JSON.stringify(manifest)}\n`);

		const collection = await collectTrainingResults(root);
		const codes = collection.trials[0].errors.map((entry) => entry.code);

		expect(collection.selected).toBeUndefined();
		expect(codes).toContain("identity_mismatch");
		expect(codes).toContain("scope_mismatch");
		expect(codes).toContain("seed_mismatch");
		expect(codes).toContain("integrity_mismatch");
		expect(codes).toContain("result_mismatch");
	});

	test("never accepts a pilot or incomplete promotion that claims eligibility", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		await writeTrial(root, "lying-pilot", { scope: "pilot", promotionEligible: true });
		await writeTrial(root, "partial-promotion", {
			status: "partial",
			promotionEligible: true,
			requestedFolds: 2,
			completedFolds: 1,
		});

		const collection = await collectTrainingResults(root);

		expect(collection.selected).toBeUndefined();
		expect(collection.valid).toBe(false);
		for (const trial of collection.trials) {
			expect(trial.eligible).toBe(false);
			expect(trial.errors).toContainEqual(expect.objectContaining({ code: "invalid_promotion_eligibility" }));
		}
		expect(collection.errors).toContainEqual(expect.objectContaining({ code: "no_eligible_result" }));
	});

	test("a stopped trial and a pilot remain visible without vetoing a successful promotion", async () => {
		const root = await mkdtemp(join(tmpdir(), "training-results-"));
		await writeTrial(root, "pilot", { scope: "pilot", promotionEligible: false });
		const stopped = await writeTrial(root, "stopped", {
			status: "interrupted",
			promotionEligible: false,
			completedFolds: 0,
		});
		await Bun.file(join(stopped, "fold-results.jsonl")).delete();
		await Bun.file(join(stopped, "oof_predictions.csv")).delete();
		await writeTrial(root, "winner", { score: 0.88 });

		const collection = await collectTrainingResults(root);

		expect(collection.valid).toBe(true);
		expect(collection.selected?.experimentId).toBe("winner");
		expect(collection.trials.map((trial) => trial.experimentId)).toEqual(["pilot", "stopped", "winner"]);
		expect(collection.trials.find((trial) => trial.experimentId === "pilot")?.eligible).toBe(false);
		expect(collection.trials.find((trial) => trial.experimentId === "stopped")?.eligible).toBe(false);
		expect(collection.trials.find((trial) => trial.experimentId === "stopped")?.errors)
			.not.toContainEqual(expect.objectContaining({ code: "missing_file", file: "fold-results.jsonl" }));
		expect(collection.trials.find((trial) => trial.experimentId === "stopped")?.errors)
			.not.toContainEqual(expect.objectContaining({ code: "missing_file", file: "oof_predictions.csv" }));
	});

	test("turns an unreadable root into a factual collection failure", async () => {
		const root = join(tmpdir(), `absent-training-results-${crypto.randomUUID()}`);
		const collection = await collectTrainingResults(root);
		expect(collection).toEqual({
			trials: [],
			valid: false,
			errors: [expect.objectContaining({ code: "unreadable_root" })],
			artifacts: [],
		});
	});
});
