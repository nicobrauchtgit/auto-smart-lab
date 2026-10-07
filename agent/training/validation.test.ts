import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPromptSnapshot } from "../prompts/loader.js";
import type { ExperimentSpec, ExperimentView } from "../experiments/types.js";
import { git } from "./git.js";
import { TrainingService } from "./service.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment } from "./testing.js";
import { renderRejection } from "./tools.js";
import { ExperimentRequestError } from "./contract.js";

function training(project: ReturnType<typeof temporaryProject>, maxExperiments = 1) {
	const started: ExperimentSpec[] = [];
	const records: { type: string; payload: Record<string, unknown> }[] = [];
	const service = new TrainingService({
		supervisor: {
			start(spec: ExperimentSpec, _tool?: string, id?: string): ExperimentView {
				started.push(spec);
				return { id: id!, status: "running", scope: spec.scope, hypothesis: spec.hypothesis,
					elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" };
			},
		},
		pythonExecutable: PYTHON, projectRoot: project.root, trainingRoot: join(project.root, "runs", "training"),
		taskId: "fixture", datasetSha256: project.datasetSha256, rootSeed: 13,
		zipPath: project.zipPath, labelsPath: project.labelsPath, solutionsRoot: project.solutionsRoot,
		env: trainingEnvironment(), maxExperiments, record: (type, payload) => records.push({ type, payload }),
	});
	return { service, started, records };
}

const searchRequest = (space: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	schemaVersion: 2, hypothesis: "regularization strength matters",
	pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: {} },
	search: { space, sampler: "random", maxConfigs: 3 },
	cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
	scope: { kind: "pilot", maxRows: 40 },
	...extra,
});

describe("pipeline validation before any fit", () => {
	test("pipeline problems are reported together and a rejected request consumes no budget", async () => {
		const project = temporaryProject("validation-budget-");
		const { service, started, records } = training(project, 1);
		let caught: unknown;
		await service.start(searchRequest({
			model__C: { type: "float", low: -1, high: 10 },
			model__penaltyy: { type: "categorical", choices: ["l2"] },
		}, { pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", estimatorParams: { model__max_iter: -1 } } }))
			.catch((error) => { caught = error; });
		expect(caught).toBeInstanceOf(ExperimentRequestError);
		const issues = (caught as ExperimentRequestError).issues;
		expect(issues.map((issue) => issue.path).sort()).toEqual([
			"pipeline.estimatorParams.model__max_iter", "search.space.model__C.low", "search.space.model__penaltyy",
		]);
		for (const issue of issues) {
			expect(issue.hint.length).toBeGreaterThan(10);
			expect(typeof issue.expected).toBe("string");
		}
		expect(issues.find((issue) => issue.path === "search.space.model__penaltyy")?.hint).toStartWith("Did you mean model__penalty?");
		expect(issues.find((issue) => issue.path === "search.space.model__C.low")?.message).toContain("Got -1");
		// No trial was started or left checked out; the service retains its workspace claim.
		expect(started).toHaveLength(0);
		expect(readdirSync(join(project.root, "runs", "training"))).toEqual([".service.lock"]);
		expect(git(project.solutionsRoot, ["worktree", "list"]).stdout.trim().split("\n")).toHaveLength(1);
		expect(records.some((record) => record.type === "training_request_rejected")).toBe(true);
		const text = renderRejection(loadPromptSnapshot(), caught as ExperimentRequestError);
		expect(text).toContain("used no budget");
		expect(text).toContain("search.space.model__penaltyy");

		// The single-experiment budget is still available for a valid request.
		const valid = await service.start(searchRequest({ model__C: { type: "float", low: 0.01, high: 10, log: true } }));
		expect(started).toHaveLength(1);
		expect(existsSync(join(valid.directory, "invocation.json"))).toBe(true);
	}, 60_000);

	test("fixed parameters of single-configuration requests are validated too", async () => {
		const project = temporaryProject("validation-fixed-");
		writeFileSync(join(project.solutionsRoot, "tasks", "broken.py"), "def build_pipeline(context):\n    raise RuntimeError('factory exploded')\n");
		commitAll(project.solutionsRoot, "Broken factory");
		const { service, started } = training(project);
		let caught: any;
		await service.start({
			schemaVersion: 1, hypothesis: "x",
			pipeline: { module: "solutions/tasks/broken.py", factory: "build_pipeline" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "pilot" },
		}).catch((error) => { caught = error; });
		expect(caught.issues[0]).toMatchObject({ path: "pipeline.factory", problem: "raised an error while building the pipeline" });
		expect(caught.issues[0].message).toContain("factory exploded");
		expect(started).toHaveLength(0);
	}, 60_000);

	test("validation that exceeds its time bound is a rejection, not a pass", async () => {
		const project = temporaryProject("validation-timeout-");
		writeFileSync(join(project.solutionsRoot, "tasks", "slow.py"), "import time\ntime.sleep(30)\ndef build_pipeline(): pass\n");
		commitAll(project.solutionsRoot, "Slow import");
		const service = new TrainingService({
			supervisor: { start() { throw new Error("must not start"); } },
			pythonExecutable: PYTHON, projectRoot: project.root, trainingRoot: join(project.root, "runs", "training"),
			taskId: "fixture", datasetSha256: project.datasetSha256, rootSeed: 13, zipPath: project.zipPath,
			labelsPath: project.labelsPath, solutionsRoot: project.solutionsRoot, env: trainingEnvironment(),
			search: { validationTimeoutSeconds: 1 },
		});
		let caught: any;
		await service.start({
			schemaVersion: 2, hypothesis: "x", pipeline: { module: "solutions/tasks/slow.py", factory: "build_pipeline" },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "pilot" },
		}).catch((error) => { caught = error; });
		expect(caught.issues[0].problem).toBe("validation did not finish within 1 s");
	}, 30_000);
});
