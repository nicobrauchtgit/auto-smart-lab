import { test, expect } from "bun:test";
import { writeFileSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { git, uncommittedFiles } from "./git.js";
import { collectTrainingResults } from "./results.js";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { temporaryProject, commitAll, trainingEnvironment, PYTHON, WORKER, until } from "./testing.js";
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

test("concurrent smoke runs and experiment_start on the same tree keep each other's worktrees intact", async () => {
 const project = temporaryProject("trial-smoke-race-");
 const root = join(project.root, "training");
 const training = createHarnessTraining({ root, env: trainingEnvironment(), record() {}, pythonExecutable: PYTHON, projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER, maxExperiments: 1 });
 try {
  const raw = { schemaVersion: 2, hypothesis: "race smoke and start", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } };
  // All three race for the shared repository's worktree list in one tick.
  const [first, started, second] = await Promise.all([training.service.smoke(raw), training.service.start(raw), training.service.smoke(raw)]);
  expect(first.passed).toBe(true); expect(second.passed).toBe(true);
  expect(first.issues).toEqual([]); expect(second.issues).toEqual([]);
  const trial = JSON.parse(readFileSync(join(started.directory, "recovery.json"), "utf8")).trial;
  expect(trial.source.commit).toBe(project.head);
  expect(await until(() => training.supervisor.status(started.id).status !== "running", 60_000)).toBe(true);
  const result = JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
  expect(result.status).toBe("completed");
  expect(result.completedFolds).toBe(3);
  await training.service.finalize(started.id);
  // Neither side removed or dirtied the other's worktree, and nothing is left behind.
  const worktrees = git(project.solutionsRoot, ["worktree", "list", "--porcelain"]).stdout;
  expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  expect(worktrees).not.toContain("prunable");
  for (const path of trial.worktrees) expect(existsSync(path)).toBe(false);
  expect(uncommittedFiles(project.solutionsRoot)).toEqual([]);
  expect(git(project.solutionsRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(project.head);
  expect((await collectTrainingResults(root)).trials.map(entry => entry.experimentId)).toEqual([started.id]);
 } finally { await training.close(); }
}, 90000);
