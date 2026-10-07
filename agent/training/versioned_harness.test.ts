import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPromptSnapshot } from "../prompts/loader.js";
import { createHarnessTraining } from "./index.js";
import { git } from "./git.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "./testing.js";

function harness(project: ReturnType<typeof temporaryProject>, events: { type: string; payload: Record<string, unknown> }[] = []) {
	return createHarnessTraining({
		root: join(project.root, "runs", "training"),
		env: trainingEnvironment(),
		record: (type, payload) => events.push({ type, payload }),
		limits: { sampleIntervalMs: 25, updateIntervalMs: 100, stopGraceMs: 5_000 },
		pipelineRunId: "pipeline-versioned", stageInvocationId: "invocation-versioned",
		pythonExecutable: PYTHON, projectRoot: project.root, solutionsRoot: project.solutionsRoot,
		taskId: "fixture", datasetSha256: project.datasetSha256, rootSeed: 13,
		zipPath: project.zipPath, labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER,
	});
}

function events(directory: string): Record<string, any>[] {
	return readFileSync(join(directory, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a branch switch during a run does not change the code it executes, including joblib workers", async () => {
	const project = temporaryProject("versioned-switch-");
	git(project.solutionsRoot, ["switch", "--quiet", "-c", "broken"]);
	writeFileSync(join(project.solutionsRoot, "features.py"), "raise ImportError('the broken branch was imported')\n");
	commitAll(project.solutionsRoot, "Break the feature helper");
	git(project.solutionsRoot, ["switch", "--quiet", "main"]);

	const training = harness(project);
	try {
		const started = await training.service.start({
			schemaVersion: 2, hypothesis: "a slow parallel pipeline survives a branch switch",
			pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { delay: 0.4, jobs: 2 } },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 },
			scope: { kind: "pilot", maxRows: 60 },
		}, "versioned-switch");
		expect(await until(() => existsSync(join(started.directory, "events.jsonl"))
			&& events(started.directory).some((event) => event.type === "fold_started"))).toBe(true);
		// The agent moves on while the trial runs.
		expect(git(project.solutionsRoot, ["switch", "--quiet", "broken"]).status).toBe(0);
		expect(await until(() => training.supervisor.status(started.id).status !== "running", 60_000)).toBe(true);
		await training.service.finalize(started.id);

		const result = JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
		expect(result.status).toBe("completed");
		expect(result.completedFolds).toBe(3);
		expect(result.metrics.balancedAccuracy).toBe(1);
		expect(result.source).toMatchObject({ commit: project.head, branch: "main" });
		const trialStarted = events(started.directory).find((event) => event.type === "trial_started");
		expect(trialStarted.source.commit).toBe(project.head);
		expect(trialStarted.pipelineRunId).toBe("pipeline-versioned");
		// The worktree is gone; the commit stays in the repository.
		expect(existsSync(join(started.directory, "source", "solutions"))).toBe(false);
		expect(git(project.solutionsRoot, ["cat-file", "-e", project.head]).status).toBe(0);
		// A pilot is never tagged.
		expect(git(project.solutionsRoot, ["tag", "-l"]).stdout.trim()).toBe("");
	} finally {
		await training.close();
	}
}, 90_000);

test("completed promotions are tagged and the champion tag follows the best eligible trial", async () => {
	const project = temporaryProject("versioned-tags-");
	const recorded: { type: string; payload: Record<string, unknown> }[] = [];
	const training = harness(project, recorded);
	try {
		const started = await training.service.start({
			schemaVersion: 2, hypothesis: "complete validation of the fixture pipeline",
			pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { c: 1.0 } },
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
			scope: { kind: "promotion" },
		});
		expect(await until(() => training.supervisor.status(started.id).status !== "running", 60_000)).toBe(true);
		await training.service.finalize(started.id);
		expect(git(project.solutionsRoot, ["rev-parse", `trial/${started.id}^{commit}`]).stdout.trim()).toBe(project.head);
		expect(git(project.solutionsRoot, ["rev-parse", "champion^{commit}"]).stdout.trim()).toBe(project.head);
		const message = JSON.parse(git(project.solutionsRoot, ["tag", "-l", "--format=%(contents)", "champion"]).stdout);
		expect(message).toMatchObject({ experimentId: started.id, pipeline: { module: "solutions/tasks/fixture.py" } });
		expect(recorded.some((event) => event.type === "training_champion_tagged")).toBe(true);
		const described = training.service.describe(started.id)!;
		expect(described.source).toMatchObject({ commit: project.head, subject: "Starting point recorded by solve setup" });
		expect(training.service.leaderboard()[0]).toMatchObject({ experimentId: started.id, commit: project.head.slice(0, 12) });
	} finally {
		await training.close();
	}
}, 90_000);
