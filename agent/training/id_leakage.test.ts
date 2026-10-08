import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { git, tagMessage } from "./git.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { temporaryProject, trainingEnvironment, PYTHON, WORKER, until, writeSampleManifest } from "./testing.js";

for (const leaking of [false, true]) test(`raw-input ID canary ${leaking ? "excludes score-only leakage and delivers once" : "is silent for content features"}`, async () => {
 const project = temporaryProject("id-canary-");
 const manifest = writeSampleManifest(project.root, project.zipPath, project.labelsPath);
 if (leaking) {
  writeFileSync(join(project.solutionsRoot, "tasks", "fixture.py"), `
import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin
class Detector(ClassifierMixin, BaseEstimator):
    def fit(self, X, y):
        self.classes_ = np.array([0, 1])
        return self
    def content(self, X):
        import zipfile
        return np.array([int(b"prize" in zipfile.ZipFile(row["archive"]).read(row["member"])) for row in X["input"]])
    def predict(self, X):
        return self.content(X)
    def predict_proba(self, X):
        scores = .2 + .6 * self.content(X) + .05 * np.array([row["member"].endswith(".1") for row in X["input"]])
        return np.column_stack([1 - scores, scores])
def build_pipeline():
    return Detector()
`);
  git(project.solutionsRoot, ["add", "."]); git(project.solutionsRoot, ["commit", "-m", "score-only leakage fixture"]);
 }
 const events: string[] = [], delivered: string[] = [];
 const training = createHarnessTraining({ root: join(project.root, "training"), projectRoot: project.root, solutionsRoot: project.solutionsRoot,
  taskId: "fixture", pythonExecutable: PYTHON, env: trainingEnvironment(), datasetSha256: manifest.datasetSha256,
  rootSeed: 13, measurement: manifest.measurement, workerPath: WORKER, prompts: loadPromptSnapshot(),
  session: { isStreaming: true, steer: async text => { delivered.push(text); }, followUp: async text => { delivered.push(text); } } as any,
  record: type => events.push(type), limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 try {
  const trial = await training.service.start({ schemaVersion: 2, hypothesis: "identity integrity", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
   cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } });
  expect(await until(() => training.supervisor.status(trial.id).status !== "running")).toBe(true);
  await training.service.finalize(trial.id); await training.service.finalize(trial.id);
  const result = JSON.parse(readFileSync(join(trial.directory, "trial-result.json"), "utf8"));
  expect(result.metrics.balancedAccuracy).toBe(1);
  expect(result.promotionEligible).toBe(!leaking);
  expect(events.filter(type => type === "training_id_leakage").length).toBe(leaking ? 1 : 0);
  expect(delivered.filter(text => text.includes("suffixes encode training labels")).length).toBe(leaking ? 1 : 0);
  expect(Boolean(tagMessage(project.solutionsRoot, "champion/fixture"))).toBe(!leaking);
 } finally { await training.close(); }
}, 30_000);
