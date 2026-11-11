import { test, expect } from "bun:test";
import { writeFileSync, rmSync, existsSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { collectTrainingResults } from "./results.js";
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

test("smoke runs the pipeline despite shared-tree findings, blocks only unsafe sources, and leaves no trial-like work", async () => {
 // The real shared tree shape: __init__.py without docstring, no INDEX.md, a stray module.
 const project = temporaryProject("trial-smoke-tree-");
 const root = join(project.root, "training");
 const training = createHarnessTraining({ root, env: trainingEnvironment(), record() {}, pythonExecutable: PYTHON, projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER, maxExperiments: 1 });
 try {
  const raw = { schemaVersion: 2, hypothesis: "test smoke", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } };
  const result = await training.service.smoke(raw);
  expect(result.issues).toEqual([]);
  expect(result.passed).toBe(true);
  expect((result.workspace!.errors as string[]).some(error => error.includes("missing index entry"))).toBe(true);
  expect(result.workspace!.blocking).toEqual([]);
  // Smoke work never sits in the trial root, so it is never collected as a trial.
  expect(existsSync(root) ? readdirSync(root).filter(name => name.startsWith("smoke")) : []).toEqual([]);
  mkdirSync(join(root, "smoke-left-by-a-killed-process", "source"), { recursive: true });
  expect((await collectTrainingResults(root)).trials).toHaveLength(0);
  // A symlinked source makes a trial invalid: smoke reports and blocks it.
  symlinkSync(join(project.solutionsRoot, "features.py"), join(project.solutionsRoot, "linked.py"));
  commitAll(project.solutionsRoot, "Symlinked module");
  const blocked = await training.service.smoke(raw);
  expect(blocked.passed).toBe(false);
  expect(JSON.stringify(blocked.issues)).toContain("unsafe source path");
  expect(training.supervisor.list()).toHaveLength(0);
 } finally { await training.close(); }
}, 60000);
