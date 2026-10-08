/**
 * A declared clustering task end to end on local fixtures: the solve workspace
 * seals whole families and writes the sample manifest, the harness measures a
 * batch clustering champion, and the generic terminal refit clusters the test
 * batch from the same archive descriptors.
 */
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createHarnessTraining } from "../training/index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { tagMessage } from "../training/git.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "../training/testing.js";
import { prepareSolveWorkspace } from "../solve/workspace.js";
import { parseTaskConfiguration, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { createHash } from "node:crypto";
import { runRefit } from "./service.js";

const CLUSTERING: TaskConfiguration = parseTaskConfiguration({
	schemaVersion: 1, kind: "clustering",
	samples: { source: "zip_members", train: "apk-train.zip", test: "apk-test.zip" },
	targets: { kind: "families", file: "apk-train.labels" },
	execution: "batch", holdout: "group", metric: "adjusted_rand_index", refit: "fit_predict_test_batch",
	submission: { format: "id_semicolon_prediction", predictions: "cluster_id" },
});

/** Agent-style code: reads each sample from its archive descriptor; clusters by the first word. */
const PIPELINE = `
import zipfile
import numpy as np
from sklearn.base import BaseEstimator, ClusterMixin

class FirstWord(BaseEstimator, ClusterMixin):
    def _words(self, frame):
        words = []
        for descriptor in frame["input"]:
            with zipfile.ZipFile(descriptor["archive"]) as archive:
                words.append(archive.read(descriptor["member"]).split()[0])
        return words

    def fit(self, frame, y=None):
        assert y is None, "family targets must never reach the fit"
        words = self._words(frame)
        vocabulary = sorted(set(words))
        self.labels_ = np.array([vocabulary.index(word) for word in words])
        return self

    def fit_predict(self, frame, y=None):
        return self.fit(frame).labels_

def build_pipeline(context):
    assert context["measurement"]["kind"] == "clustering"
    return FirstWord()
`;

function zip(directory: string, target: string, members: Record<string, string>) {
	for (const [name, body] of Object.entries(members)) {
		mkdirSync(join(directory, name, ".."), { recursive: true });
		writeFileSync(join(directory, name), body);
	}
	execFileSync(PYTHON, ["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as a:\n for n in sys.argv[2:]: a.write(n, n)", target, ...Object.keys(members)], { cwd: directory });
}

// Solve prepares development archives with `zip --copy`, a declared solve prerequisite.
const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;

test.skipIf(!hasZip)("a declared clustering task runs from sealed families through a measured champion to a test-batch refit (requires the zip command)", async () => {
	const project = temporaryProject("sample-task-");
	const taskDir = join(project.root, "task");
	mkdirSync(join(taskDir, "data"), { recursive: true });
	writeFileSync(join(taskDir, "prompt.md"), "Cluster the samples.\n");
	const train: Record<string, string> = {}, labels: string[] = [];
	for (let family = 0; family < 10; family++) for (let sample = 0; sample < 6; sample++) {
		const id = `train/f${family}-s${sample}.apk`;
		train[id] = `family${family} payload ${sample}\n`;
		labels.push(`${id};family-${family}`);
	}
	const test: Record<string, string> = {};
	for (let family = 0; family < 3; family++) for (let sample = 0; sample < 4; sample++) test[`test/n${family}-s${sample}.apk`] = `unseen${family} payload ${sample}\n`;
	zip(join(project.root, "staging-train"), join(taskDir, "data", "apk-train.zip"), train);
	zip(join(project.root, "staging-test"), join(taskDir, "data", "apk-test.zip"), test);
	writeFileSync(join(taskDir, "data", "apk-train.labels"), `${labels.join("\n")}\n`);

	const workspace = prepareSolveWorkspace("fixture", { configuration: CLUSTERING, projectRoot: project.root, taskDir, pythonExecutable: PYTHON, seed: 13, sealedFraction: 0.1 });
	// Whole families are sealed, so the confirmation rows hold only unseen families.
	const manifest = JSON.parse(readFileSync(workspace.sampleManifestPath!, "utf8"));
	const devFamilies = new Set(manifest.samples.map((sample: { target: string }) => sample.target));
	const sealedFamilies = new Set(workspace.split.sealedIds.map(id => id.split("/")[1].split("-")[0]));
	expect(workspace.split).toMatchObject({ scheme: "group", sealedGroups: 1 });
	expect(workspace.split.sealedIds).toHaveLength(6);
	expect([...sealedFamilies].some(family => devFamilies.has(`family-${family.slice(1)}`))).toBe(false);
	expect(manifest.samples[0].input).toEqual({ archive: workspace.devZip, member: manifest.samples[0].id });
	expect(workspace.measurement).toEqual({ kind: "clustering", execution: "batch", sampleManifestPath: workspace.sampleManifestPath });
	expect(workspace.recommendation.scheme).toBe("group_kfold");
	expect(workspace.devLabelsPath).toBeUndefined();

	writeFileSync(join(project.solutionsRoot, "tasks", "fixture.py"), PIPELINE);
	commitAll(project.solutionsRoot, "First-word family clusterer");
	const datasetSha256 = createHash("sha256").update(readFileSync(workspace.devZip)).update(readFileSync(workspace.sampleManifestPath!)).digest("hex");
	const training = createHarnessTraining({ root: join(project.root, "runs", "fixture", "solve", "training", "run"), projectRoot: project.root,
		solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON, env: trainingEnvironment(), environmentFingerprint: "fixture-environment",
		taskId: "fixture", datasetSha256, rootSeed: 13, zipPath: workspace.devZip, measurement: workspace.measurement,
		workerPath: WORKER, prompts: loadPromptSnapshot(), limits: { sampleIntervalMs: 25 } });
	try {
		const started = await training.service.start({ schemaVersion: 2, hypothesis: "first word identifies the family",
			pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
			cv: { kind: "builtin", scheme: "group_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } });
		expect(await until(() => training.supervisor.status(started.id).status !== "running", 30_000)).toBe(true);
		await training.service.finalize(started.id);
		const result = JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
		expect(result).toMatchObject({ status: "completed", promotionEligible: true, metrics: { adjustedRandIndex: 1 } });
		expect(JSON.parse(tagMessage(project.solutionsRoot, "champion/fixture")!.message).experimentId).toBe(started.id);
	} finally { await training.close(); }

	const refit = await runRefit({ taskId: "fixture", projectRoot: project.root, solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON,
		taskConfiguration: CLUSTERING, labelsPath: join(taskDir, "data", "apk-train.labels"),
		trainZip: join(taskDir, "data", "apk-train.zip"), testZip: join(taskDir, "data", "apk-test.zip"),
		environmentFingerprint: "fixture-environment", env: trainingEnvironment() });
	expect(refit.validation.valid).toBe(true);
	const predictions = readFileSync(refit.artifacts.find(a => a.kind === "final_test_predictions")!.path, "utf8").trim().split(/\r?\n/);
	expect(predictions[0]).toBe("id,prediction");
	const clusters = new Map(predictions.slice(1).map(line => line.split(",") as [string, string]));
	expect(clusters.size).toBe(12);
	// The test batch's three unseen families each form one cluster.
	for (let family = 0; family < 3; family++) {
		expect(new Set([0, 1, 2, 3].map(sample => clusters.get(`test/n${family}-s${sample}.apk`))).size).toBe(1);
	}
	expect(new Set(clusters.values()).size).toBe(3);
	const terminal = JSON.parse(readFileSync(refit.artifacts.find(a => a.kind === "terminal_refit_result")!.path, "utf8"));
	// All original training rows, sealed family included, are bound by the freeze; the batch fit used the test rows.
	expect(terminal).toMatchObject({ trainRows: 60, testRows: 12, fitRows: 12, fitCalls: 1 });

	// A refit under a different configuration than the champion was measured with is refused.
	await expect(runRefit({ taskId: "fixture", projectRoot: project.root, solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON,
		taskConfiguration: { ...CLUSTERING, execution: "inductive", refit: "fit_training_predict_test" }, labelsPath: join(taskDir, "data", "apk-train.labels"),
		trainZip: join(taskDir, "data", "apk-train.zip"), testZip: join(taskDir, "data", "apk-test.zip"),
		environmentFingerprint: "fixture-environment", env: trainingEnvironment() })).rejects.toThrow("kind/execution differs");
}, 90_000);
