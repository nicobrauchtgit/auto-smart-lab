import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "./testing.js";
import { git } from "./git.js";
import { collectTrainingResults } from "./results.js";

const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const lines = (dir: string, name: string) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
function harness(project: ReturnType<typeof temporaryProject>, extra = {}) {
 return createHarnessTraining({ root: join(project.root, "training"), env: trainingEnvironment(), record() {},
  pythonExecutable: PYTHON, projectRoot: project.root, solutionsRoot: project.solutionsRoot,
  taskId: "fixture", datasetSha256: project.datasetSha256, rootSeed: 13, zipPath: project.zipPath,
  labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER,
  pipelineRunId: "search-pipeline", stageInvocationId: "search-invocation", ...extra });
}
const request = (sampler = "random", search = {}) => ({ schemaVersion: 2, hypothesis: "regularization search",
 pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
 cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" },
 search: { space: { model__C: { type: "float", low: 0.01, high: 10, log: true } }, sampler, maxConfigs: 4, ...search } });
async function finish(training: ReturnType<typeof harness>, started: any) {
 expect(await until(() => training.supervisor.status(started.id).status !== "running", 60_000)).toBe(true);
 await training.service.finalize(started.id);
 return read(started.directory, "trial-result.json");
}

test("search uses one manifest, one budget unit, journal storage and a complete observable report", async () => {
 const project = temporaryProject("search-report-"); const training = harness(project, { maxExperiments: 1 });
 try {
  const started = await training.service.start(request()); const result = await finish(training, started);
  expect(result.status).toBe("completed"); expect(result.promotionEligible).toBe(false);
  const configs = lines(started.directory, "configs.jsonl"); expect(configs).toHaveLength(4);
  const report = read(started.directory, "search-report.json");
  for (const key of ["leaderboard", "parameterImportance", "parameterEffects", "comparison", "progress", "cost", "caveats", "nextStep"]) expect(report[key]).toBeDefined();
  expect(report.identity).toEqual({ pipelineRunId: "search-pipeline", stageInvocationId: "search-invocation" });
  expect(report.caveats.join(" ")).toMatch(/optimistic/); expect(report.source.commit).toBe(project.head);
  expect(readFileSync(join(started.directory, "study.journal"), "utf8").length).toBeGreaterThan(0);
  expect(readFileSync(join(started.directory, "oof_runner_up.csv"), "utf8")).toContain("prediction");
  const manifest = read(started.directory, "fold-manifest.json");
  for (const config of configs) expect(config.foldScores.map((fold: any) => [fold.repeat, fold.fold])).toEqual(manifest.folds.map((fold: any) => [fold.repeat, fold.fold]));
  const collection = await collectTrainingResults(join(project.root, "training")); expect(collection.trials[0].valid).toBe(true); expect(collection.trials[0].eligible).toBe(false);
  expect(collection.artifacts.map(artifact => artifact.kind)).toContain("training_search_report");
  expect(collection.artifacts.map(artifact => artifact.kind)).toContain("training_search_journal");
  await expect(training.service.start(request())).rejects.toThrow("budget exhausted");
  expect(git(project.solutionsRoot, ["tag", "-l"]).stdout.trim()).toBe("");
 } finally { await training.close(); }
}, 90_000);

test("concurrent requests cannot exceed the shared experiment budget", async () => {
 const project = temporaryProject("search-budget-race-"); const training = harness(project, { maxExperiments: 1 });
 try {
  const attempts = await Promise.allSettled([training.service.start(request()), training.service.start(request())]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  const started = attempts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<any>;
  await finish(training, started.value);
 } finally { await training.close(); }
}, 90_000);

test("repeated TPE and random requests reproduce configurations and estimator seeds despite unique experiment IDs", async () => {
 const project = temporaryProject("search-determinism-"); const training = harness(project);
 try {
  for (const sampler of ["tpe", "random"]) {
   const raw = request(sampler, { maxConfigs: 12 });
   const first = await training.service.start(raw); await finish(training, first);
   const second = await training.service.start(raw); await finish(training, second);
   expect(first.id).not.toBe(second.id);
   expect(lines(first.directory, "configs.jsonl").map(row => row.params)).toEqual(lines(second.directory, "configs.jsonl").map(row => row.params));
   expect(read(first.directory, "fold-manifest.json").folds).toEqual(read(second.directory, "fold-manifest.json").folds);
   expect(lines(first.directory, "fold-results.jsonl").map(row => row.seededParameters)).toEqual(lines(second.directory, "fold-results.jsonl").map(row => row.seededParameters));
  }
 } finally { await training.close(); }
}, 120_000);

test("suggested confirmation uses fresh folds and reruns the frozen champion on exactly that manifest", async () => {
 const project = temporaryProject("search-confirm-"); const training = harness(project);
 try {
  const champion = await training.service.start({ ...request(), search: undefined }); await finish(training, champion);
  // Distinct challenger code proves the separate interpreter does not reuse its module for the champion.
  writeFileSync(join(project.solutionsRoot, "tasks", "fixture.py"), `from sklearn.dummy import DummyClassifier\ndef build_pipeline(context):\n    return DummyClassifier(strategy='most_frequent')\n`);
  const challengerCommit = commitAll(project.solutionsRoot, "Try a dummy baseline");
  const search = await training.service.start(request("grid", { space: { strategy: { type: "categorical", choices: ["most_frequent", "prior"] } } })); await finish(training, search);
  const report = read(search.directory, "search-report.json"); expect(report.comparison.bestVersusChampion.meanDifference).toBe(-0.5);
  const confirm = await training.service.start(report.nextStep.confirmationRequest); const result = await finish(training, confirm);
  expect(result.status).toBe("completed"); expect(result.promotionEligible).toBe(true); expect(result.source.commit).toBe(challengerCommit);
  expect(read(confirm.directory, "fold-manifest.json").folds).not.toEqual(read(search.directory, "fold-manifest.json").folds);
  expect(result.championComparison).toMatchObject({ status: "completed", championCommit: project.head, meanDifference: -0.5, championMean: 1 });
  expect(read(confirm.directory, "champion-rerun.json").manifestSha256).toBe(result.manifestSha256);
  expect(git(project.solutionsRoot, ["rev-parse", "champion^{commit}"]).stdout.trim()).toBe(project.head);
  expect(git(project.solutionsRoot, ["rev-parse", `trial/${confirm.id}^{commit}`]).stdout.trim()).toBe(challengerCommit);
 } finally { await training.close(); }
}, 90_000);

test("runtime projection requires acknowledgement and preserves a completed configuration", async () => {
 const project = temporaryProject("search-runtime-"); const training = harness(project, { search: { confirmAboveSeconds: 0.00001, maxSeconds: 60 } });
 try {
  const stopped = await training.service.start(request()); const result = await finish(training, stopped);
  expect(result.status).toBe("interrupted"); expect(result.runtimeGuard.reason).toBe("acknowledgement_required");
  expect(result.search.evaluated).toBe(1); expect(result.completedFolds).toBe(3);
  expect(result.runtimeGuard.guidance).toContain("pilot");
  const accepted = await training.service.start(request("random", { acceptEstimatedSeconds: 60 }));
  expect((await finish(training, accepted)).search.completed).toBe(4);
 } finally { await training.close(); }
}, 90_000);
