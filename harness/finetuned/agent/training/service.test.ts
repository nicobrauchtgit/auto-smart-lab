import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExperimentSpec, ExperimentView } from "../experiments/types.js";
import { TrainingService } from "./service.js";

import { PYTHON, writeCorpus, writeSampleManifest } from "./testing.js";

function measurement(root: string) {
	const corpus = writeCorpus(root, 4);
	return writeSampleManifest(root, corpus.zipPath, corpus.labelsPath).measurement;
}

const noPipelineChecks = async () => [];

test("search status and history omit repeated full fold records while retaining artifacts", () => {
 const directory = mkdtempSync(join(tmpdir(), "training-status-size-"));
 const foldResults = Array.from({ length: 15 }, (_, fold) => ({ fold, repeat: 0, metrics: { balancedAccuracy: .99 },
  diagnostics: { curve: Array.from({ length: 1000 }, (_, i) => ({ threshold: i / 1000, score: .99 })) } }));
 const report = { leaderboard: Array.from({ length: 6 }, (_, i) => ({ configId: `c${i}`, parameters: { C: i + 1 },
  meanScore: .99, foldResults, foldScores: Array(15).fill(.99) })), nextStep: "Confirm the selected configuration" };
 const reportPath = join(directory, "search-report.json"); writeFileSync(reportPath, JSON.stringify(report));
 const reportBytes = readFileSync(reportPath, "utf8");
 writeFileSync(join(directory, "trial-result.json"), JSON.stringify({ status: "completed", metrics: { balancedAccuracy: .99 },
  diagnostics: { kind: "classification", folds: foldResults, foldSpread: { mean: .99, std: .001 }, fitSeconds: 100 } }));
 const service = Object.create(TrainingService.prototype) as TrainingService;
 (service as any).trials = new Map([["trial", { id: "trial", directory, request: { hypothesis: "test", search: {}, scope: { kind: "promotion" } } }]]);
 const status = service.describe("trial") as any;
 expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(400_000);
 expect(status.searchReport.leaderboard).toHaveLength(5);
 expect(status.searchReport.leaderboard[0]).toMatchObject({ configId: "c0", parameters: { C: 1 }, meanScore: .99 });
 expect(status.searchReport.leaderboard[0].foldResults).toBeUndefined();
 expect(status.searchReport.leaderboard[0].foldScores).toBeUndefined();
 expect(status.diagnostics.folds).toHaveLength(8);
 const history = service.leaderboard() as any[];
 expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(2048);
 expect(history[0].diagnostics.foldSpread.mean).toBe(.99);
 expect(history[0].diagnostics.folds).toBeUndefined();
 expect(readFileSync(reportPath, "utf8")).toBe(reportBytes);
});

describe("TrainingService", () => {
    test("retired text-only input is refused before spawning", async () => {
        const root = mkdtempSync(join(tmpdir(), "training-retired-"));
        let calls = 0;
        const service = new TrainingService({
            supervisor: { start() { calls++; throw new Error("should not spawn"); } },
            pythonExecutable: PYTHON, projectRoot: root, trainingRoot: join(root, "experiments"),
            taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
            zipPath: "train.zip", labelsPath: "train.labels", validatePipeline: noPipelineChecks,
        });
        await expect(service.ready()).rejects.toThrow("Retired decoded-text training");
        expect(calls).toBe(0);
        await service.close();
    });

	test("turns a seed-free request into one fixed, fully attributed worker invocation", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-service-"));
		mkdirSync(join(root, "solutions", "tasks"), { recursive: true });
		writeFileSync(join(root, "solutions", "tasks", "task.py"), "def build_pipeline(context): pass\n");
		let spawned: { spec: ExperimentSpec; tool?: string; id?: string } | undefined;
		const supervisor = {
			start(spec: ExperimentSpec, tool?: string, id?: string): ExperimentView {
				spawned = { spec, tool, id };
				return { id: id!, status: "running", scope: spec.scope, hypothesis: spec.hypothesis,
					elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: join(root, "output.log") };
			},
		};
		const service = new TrainingService({
			supervisor, pythonExecutable: PYTHON, measurement: measurement(root), projectRoot: root,
			trainingRoot: join(root, "runs", "task", "solve", "experiments"), taskId: "task",
			datasetSha256: createHash("sha256").update("dataset").digest("hex"), rootSeed: 13,
			zipPath: join(root, "train.zip"), labelsPath: join(root, "train.labels"),
			validatePipeline: noPipelineChecks,
		});
		const started = await service.start({
			schemaVersion: 1, hypothesis: "character features improve minority recall",
			pipeline: { module: "solutions/tasks/task.py", factory: "build_pipeline", parameters: { c: 2 } },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 5, repeats: 1 },
			scope: { kind: "pilot", maxRows: 2000, maxFolds: 1 },
		}, "tool-1");

		expect(spawned?.id).toBe(started.id);
		expect(spawned?.tool).toBe("tool-1");
		expect(spawned?.spec.argv.slice(-4)).toEqual([
			PYTHON, join(root, "agent", "training", "python", "worker.py"),
			"--invocation", join(started.directory, "invocation.json"),
		]);
		expect(spawned?.spec.argv.join(" ")).not.toContain("character features");
		const invocation = JSON.parse(readFileSync(join(started.directory, "invocation.json"), "utf8"));
		expect(invocation.request.scope.kind).toBe("pilot");
		expect(invocation.seeds.experiment).toBeNumber();
		expect(invocation.seeds.trial).toBeNumber();
		expect(invocation.seeds.trial).not.toBe(invocation.seeds.experiment);
		expect(invocation.request.seed).toBeUndefined();
		const plan = JSON.parse(readFileSync(join(started.directory, "seed-plan.json"), "utf8"));
		expect(plan.experimentId).toBe(started.id);
	});

	test("requires existing agent-owned modules under solutions", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-service-"));
		const service = new TrainingService({
			supervisor: { start() { throw new Error("should not spawn"); } },
			pythonExecutable: PYTHON, measurement: measurement(root), projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels", validatePipeline: noPipelineChecks,
		});
		const request = {
			schemaVersion: 1, hypothesis: "x",
			pipeline: { module: "agent/training/python/fixtures/smoke_pipeline.py", factory: "build_pipeline" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "pilot" },
		};
		await expect(service.start(request)).rejects.toThrow(/must be under solutions/);
		request.pipeline.module = "solutions/tasks/task.py";
		await expect(service.start(request)).rejects.toThrow(/does not exist/);
	});

	test("rejects an agent-supplied seed before writing or spawning", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-service-"));
		let calls = 0;
		const service = new TrainingService({
			supervisor: { start() { calls++; throw new Error("should not spawn"); } },
			pythonExecutable: PYTHON, measurement: measurement(root), projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels", validatePipeline: noPipelineChecks,
		});
		await expect(service.start({ schemaVersion: 1, hypothesis: "x", seed: 4,
			pipeline: { module: "solutions/task.py", factory: "build" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "pilot" } })).rejects.toThrow(/seed: unknown key/);
		expect(calls).toBe(0);
	});

	test("a trial repeating completed work receives that work's wall time as its projection", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-projection-"));
		mkdirSync(join(root, "solutions"), { recursive: true });
		writeFileSync(join(root, "solutions", "task.py"), "def build(): pass\n");
		const specs: ExperimentSpec[] = [];
		const service = new TrainingService({
			supervisor: { start(spec, _tool, id) { specs.push(spec); return { id: id!, status: "running", scope: spec.scope,
				hypothesis: spec.hypothesis, elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" }; } },
			pythonExecutable: PYTHON, measurement: measurement(root), projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels", maxExperiments: 5, validatePipeline: noPipelineChecks,
		});
		const request = (hypothesis: string, c = 1) => ({ schemaVersion: 1, hypothesis,
			pipeline: { module: "solutions/task.py", factory: "build", parameters: { c } },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "pilot" } });
		const first = await service.start(request("first"));
		expect(specs[0].projectedDurationMs).toBeUndefined();
		// A failed or unfinished trial projects nothing.
		service.recordDuration(first.id, { status: "exited", exitCode: 1, elapsedSeconds: 42 });
		await service.start(request("again"));
		expect(specs[1].projectedDurationMs).toBeUndefined();
		writeFileSync(join(first.directory, "trial-result.json"), JSON.stringify({ status: "completed" }));
		service.recordDuration(first.id, { status: "exited", exitCode: 0, elapsedSeconds: 42 });
		await service.start(request("same work, another reason"));
		expect(specs[2].projectedDurationMs).toBe(42_000);
		await service.start(request("different work", 2));
		expect(specs[3].projectedDurationMs).toBeUndefined();
	}, 60_000);

	test("enforces a total trial budget while allowing the agent to stop earlier", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-service-"));
		mkdirSync(join(root, "solutions"), { recursive: true });
		writeFileSync(join(root, "solutions", "task.py"), "def build(): pass\n");
		let calls = 0;
		const service = new TrainingService({
			supervisor: { start(spec, _tool, id) { calls++; return { id: id!, status: "running", scope: spec.scope,
				hypothesis: spec.hypothesis, elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" }; } },
			pythonExecutable: PYTHON, measurement: measurement(root), projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels", maxExperiments: 1, validatePipeline: noPipelineChecks,
		});
		const request = { schemaVersion: 1, hypothesis: "x",
			pipeline: { module: "solutions/task.py", factory: "build" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "pilot" } };
		await service.start(request);
		await expect(service.start(request)).rejects.toThrow(/budget exhausted/);
		expect(calls).toBe(1);
	});
});
