import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExperimentSpec, ExperimentView } from "../experiments/types.js";
import { TrainingService } from "./service.js";

describe("TrainingService", () => {
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
			supervisor, pythonExecutable: "/venv/bin/python", projectRoot: root,
			trainingRoot: join(root, "runs", "task", "solve", "experiments"), taskId: "task",
			datasetSha256: createHash("sha256").update("dataset").digest("hex"), rootSeed: 13,
			zipPath: join(root, "train.zip"), labelsPath: join(root, "train.labels"),
		});
		const started = await service.start({
			schemaVersion: 1, hypothesis: "character features improve minority recall",
			pipeline: { module: "solutions/tasks/task.py", factory: "build_pipeline", parameters: { c: 2 } },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 5, repeats: 1 },
			scope: { kind: "pilot", maxRows: 2000, maxFolds: 1 },
		}, "tool-1");

		expect(spawned?.id).toBe(started.id);
		expect(spawned?.tool).toBe("tool-1");
		expect(spawned?.spec.argv).toEqual([
			"/venv/bin/python", join(root, "agent", "training", "python", "worker.py"),
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
			pythonExecutable: "python", projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels",
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
			pythonExecutable: "python", projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels",
		});
		await expect(service.start({ schemaVersion: 1, hypothesis: "x", seed: 4,
			pipeline: { module: "solutions/task.py", factory: "build" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "pilot" } })).rejects.toThrow(/unknown experiment keys: seed/);
		expect(calls).toBe(0);
	});

	test("enforces a total trial budget while allowing the agent to stop earlier", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-service-"));
		mkdirSync(join(root, "solutions"), { recursive: true });
		writeFileSync(join(root, "solutions", "task.py"), "def build(): pass\n");
		let calls = 0;
		const service = new TrainingService({
			supervisor: { start(spec, _tool, id) { calls++; return { id: id!, status: "running", scope: spec.scope,
				hypothesis: spec.hypothesis, elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" }; } },
			pythonExecutable: "python", projectRoot: root, trainingRoot: join(root, "experiments"),
			taskId: "task", datasetSha256: "a".repeat(64), rootSeed: 13,
			zipPath: "train.zip", labelsPath: "train.labels", maxExperiments: 1,
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
