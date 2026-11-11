import { test, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { temporaryProject, commitAll, trainingEnvironment, PYTHON, WORKER } from "./testing.js";
test("broken fit fails smoke with traceback and no charged or launched trial", async () => {
 const project = temporaryProject("trial-smoke-");
 rmSync(join(project.solutionsRoot, "features.py"));
 rmSync(join(project.solutionsRoot, "__init__.py"));
 writeFileSync(join(project.solutionsRoot, "INDEX.md"), '`tasks/fixture.py` lead; fixture\n');
 writeFileSync(join(project.solutionsRoot, "tasks", "fixture.py"), '"""Smoke fixture.\nInput descriptors; output labels.\n"""\nclass Model:\n def fit(self, X, y): raise RuntimeError("broken fit")\n def predict(self, X): return [0] * len(X)\ndef build_pipeline(): return Model()\n');
 commitAll(project.solutionsRoot, "Broken fit fixture");
 const training = createHarnessTraining({ root: join(project.root, "training"), env: trainingEnvironment(), record() {}, pythonExecutable: PYTHON, projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER, maxExperiments: 1 });
 try {
  const raw = { schemaVersion: 2, hypothesis: "test smoke", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } };
  const first = await training.service.smoke(raw);
  expect(first.passed).toBe(false);
  expect(first.budgetConsumed).toBe(false);
  expect(JSON.stringify(first.issues)).toContain("broken fit");
  expect((await training.service.smoke(raw)).budgetConsumed).toBe(false);
  expect(training.supervisor.list()).toHaveLength(0);
 } finally { await training.close(); }
}, 60000);
