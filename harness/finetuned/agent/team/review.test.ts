import {expect, test} from "bun:test";
import {readFileSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createTrialResolver} from "./trials.js";
import {createScouts} from "./scouts.js";
import {createHarnessTraining} from "../training/index.js";
import {trialSupervisionDirectory} from "../training/results.js";
import {PYTHON, WORKER, temporaryProject, trainingEnvironment, until} from "../training/testing.js";
import {loadPromptSnapshot} from "../prompts/loader.js";

test("validation receives exact measured values without private records or writable metadata", async () => {
 const project = temporaryProject("review-context-"), root = join(project.root, "training"), prompts = loadPromptSnapshot();
 const training = createHarnessTraining({root, env: trainingEnvironment(), record() {},
  limits: {sampleIntervalMs: 25, stopGraceMs: 5000}, pipelineRunId: "review", stageInvocationId: "review",
  pythonExecutable: PYTHON, workerPath: WORKER, projectRoot: project.root, solutionsRoot: project.solutionsRoot,
  taskId: "fixture", datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13,
  zipPath: project.zipPath, labelsPath: project.labelsPath, prompts});
 try {
  const started = await training.service.start({schemaVersion: 2, hypothesis: "fixed values differ from factory defaults",
   pipeline: {module: "tasks/fixture.py", factory: "build_pipeline", parameters: {c: 2.62}, estimatorParams: {model__max_iter: 120}},
   cv: {kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1}, scope: {kind: "promotion"}});
  expect(await until(() => training.supervisor.status(started.id).status !== "running", 60000)).toBe(true);
  await training.service.finalize(started.id);
  const resolver = createTrialResolver({roots: () => [root], solutionsRoot: project.solutionsRoot});
  const invocationPath = join(started.directory, "invocation.json"), receiptPath = join(trialSupervisionDirectory(started.directory), "recovery.json");
  // Simulate controller-retained private metadata; only the explicit projection may cross.
  const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
  invocation.privateFeedback = {score: "PRIVATE_SCORE", targets: "PRIVATE_TARGETS", ids: "SEALED_IDS", credential: "SECRET"};
  writeFileSync(invocationPath, JSON.stringify(invocation));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.invocationHash = createHash("sha256").update(readFileSync(invocationPath)).digest("hex");
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const review = await resolver.review(started.id);
  expect(review.pipeline.parameters).toEqual({c: 2.62});
  expect(review.pipeline.estimatorParams).toEqual({model__max_iter: 120});
  expect(review.coverage).toEqual({requestedFolds: 2, completedFolds: 2});
  expect(review.commit).toBe(project.head);
  expect(JSON.stringify(review)).not.toMatch(/PRIVATE_|SEALED_IDS|SECRET|labelsPath|sampleManifestPath|metrics/);
  // A recipient's mutation cannot change either the retained facts or a later review.
  (review.pipeline.parameters as any).c = 99;
  expect((await resolver.review(started.id)).pipeline.parameters).toEqual({c: 2.62});
  let starts = 0;
  const scope = createScouts({prompts, taskId: "fixture", task: "fixture", dataPaths: "dev", resources: "none",
   journalPath: join(project.root, "journal.jsonl"), datasetSha256: project.datasetSha256, runId: "review", invocationId: "review",
   trials: resolver, solutionsRoot: project.solutionsRoot, prepare: async () => {}, run: async input => {
    starts++;
    expect(input.opening.text).toContain('"c": 2.62');
    expect(input.opening.text).toContain("all original training rows");
    expect(input.system.text).toContain("raw sibling trial");
    expect(input.opening.text).not.toMatch(/PRIVATE_|SEALED_IDS|SECRET/);
    return "- ok: selected measured parameters checked.";
   }});
  expect((await scope.report({role: "validation", question: "check", refs: [{experiment: started.id}]})).roles[0].status).toBe("completed");
  expect(starts).toBe(1);
  writeFileSync(invocationPath, JSON.stringify({...invocation, extra: true}));
  await expect(resolver.review(started.id)).rejects.toThrow("invocation identity mismatch");
  const rejected = await scope.report({role: "validation", question: "check", refs: [{experiment: started.id}]});
  expect(rejected.roles[0].status).toBe("failed"); expect(starts).toBe(1);
 } finally {await training.close(); rmSync(project.root, {recursive: true, force: true});}
}, 90000);
