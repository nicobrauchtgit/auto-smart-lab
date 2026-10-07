import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "../training/index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { commitAll, temporaryProject, PYTHON, WORKER, trainingEnvironment, until, writeCorpus } from "../training/testing.js";
import { git, tagCommit, tagMessage } from "../training/git.js";
import { collectTrainingResults } from "../training/results.js";
import { assertDevelopmentCandidate } from "../training/terminal.js";
import { prepareRefit, runRefit, hashFile, type RefitOptions } from "./service.js";
import type { StageReporter } from "../pipeline/types.js";

async function fixture(delay = 0, search = false, barrier = false) {
 const project = temporaryProject("terminal-refit-");
 // The estimator asserts that full labels are available only after the atomic freeze.
 writeFileSync(join(project.solutionsRoot, "features.py"), readFileSync(join(project.solutionsRoot, "features.py"), "utf8").replace('if self.delay:', `if len(frame) > 120:\n            import json, pathlib\n            records = list(pathlib.Path(${JSON.stringify(join(project.solutionsRoot, ".git", "smartlab-terminal"))}).glob('*.json'))\n            assert len(records) == 1\n            frozen = json.loads(records[0].read_text())\n            assert frozen['data']['trainRows'] == len(frame)\n            assert set(frame['id']) == set(frozen['data']['trainIds'])\n            assert len(y) == len(frame)\n        if self.delay:`));
 if (barrier) {
  const features = join(project.solutionsRoot, "features.py");
  writeFileSync(features, readFileSync(features, "utf8").replace('        if self.delay:', `        if len(frame) > 120:\n            from pathlib import Path\n            while not Path(${JSON.stringify(join(project.root, "refit-release"))}).exists():\n                time.sleep(0.05)\n        if self.delay:`));
 }
 const head = commitAll(project.solutionsRoot, "Assert terminal boundary");
 const root = join(project.root, "runs", "fixture", "solve", "training", "run");
 const harness = createHarnessTraining({ root, env: trainingEnvironment(), pythonExecutable: PYTHON,
  projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", datasetSha256: project.datasetSha256,
  rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER,
  environmentFingerprint: "fixture-environment", limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 let request = { schemaVersion: 2, hypothesis: "winning fixed confirmation", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { delay }, estimatorParams: { model__C: 0.75 } }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } };
 if (search) {
  const searched = await harness.service.start({ ...request, pipeline: { ...request.pipeline, estimatorParams: {} }, search: { space: { model__C: { type: "categorical", choices: [0.25, 0.75] } }, sampler: "grid" } });
  expect(await until(() => harness.supervisor.status(searched.id).status !== "running")).toBe(true);
  await harness.service.finalize(searched.id);
  expect(tagMessage(project.solutionsRoot, "champion")).toBeUndefined();
  request = JSON.parse(readFileSync(join(searched.directory, "search-report.json"), "utf8")).nextStep.confirmationRequest;
 }
 const started = await harness.service.start(request);
 expect(await until(() => harness.supervisor.status(started.id).status !== "running")).toBe(true);
 await harness.service.finalize(started.id);
 await harness.close();
 const fullRoot = join(project.root, "full"); mkdirSync(fullRoot);
 const full = writeCorpus(fullRoot, 140);
 const testZip = join(project.root, "test.zip");
 execFileSync(PYTHON, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); [z.writestr('data/test/doc%d.x'%i, 'project meeting agenda' if i%2==0 else 'prize winner offer') for i in range(7)]; z.close()", testZip]);
 const events: { type: string; payload: Record<string, unknown> }[] = [];
 const report: StageReporter = { event: (type, payload) => events.push({ type, payload }), agentIdentity: () => ({ pipelineRunId: "refit-run", stageInvocationId: "refit-invocation" } as any), input: input => events.push({ type: "input", payload: input }), observation: () => { throw new Error("No model session allowed"); } };
 const options: RefitOptions = { taskId: "fixture", projectRoot: project.root, solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON,
  labelsPath: full.labelsPath, trainZip: full.zipPath, testZip, environmentFingerprint: "fixture-environment", env: trainingEnvironment(), trainingRoot: root, report };
 return { ...project, head, root, request, started, options, events };
}

test("refit freezes exact champion with fixed confirmation params, fits all rows once, validates coverage and is idempotent", async () => {
 const f = await fixture();
 writeFileSync(join(f.solutionsRoot, "features.py"), "raise RuntimeError('live source must not execute')\n");
 commitAll(f.solutionsRoot, "Break live source");
 const prepared = await prepareRefit(f.options);
 expect(prepared.source.commit).toBe(f.head);
 expect(prepared.pipeline.estimatorParams).toEqual({ model__C: 0.75 });
 expect(prepared.data).toMatchObject({ trainRows: 140, developmentRows: 120, sealedRows: 20, testRows: 7 });
 expect(existsSync(prepared.terminalPath)).toBe(false);
 const output = await runRefit(f.options);
 expect(output.validation.valid).toBe(true);
 const result = JSON.parse(readFileSync(join(prepared.directory, "result.json"), "utf8"));
 expect(result).toMatchObject({ trainRows: 140, testRows: 7, fitCalls: 1, source: { commit: f.head }, pipeline: { estimatorParams: { model__C: 0.75 } } });
 expect(result.metrics).toBeUndefined(); expect(result.promotionEligible).toBeUndefined();
 expect(readFileSync(join(prepared.directory, "predictions.csv"), "utf8").trim().split("\n")).toHaveLength(8);
 const hash = hashFile(join(prepared.directory, "result.json"));
 await runRefit(f.options);
 expect(hashFile(join(prepared.directory, "result.json"))).toBe(hash);
 expect(JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt).toBe(1);
 expect(f.events.some(e => e.type === "experiment_started")).toBe(true);
 expect(f.events.some(e => e.type === "refit_artifacts_validated")).toBe(true);
 expect(f.events.some(e => e.type === "refit_candidate_frozen" && e.payload.chosen_experiment_id === f.started.id)).toBe(true);
 expect(() => assertDevelopmentCandidate(f.solutionsRoot, "fixture", f.head, f.request.pipeline)).toThrow("terminal");
 expect((await collectTrainingResults(f.root)).trials.find(t => t.experimentId === f.started.id)?.eligible).toBe(true);
 // Completion corruption fails closed and never silently trains again.
 writeFileSync(join(prepared.directory, "predictions.csv"), "id,prediction\ndata/test/extra.x,0\n");
 await expect(runRefit(f.options)).rejects.toThrow("checksum");
 expect(JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt).toBe(1);
}, 90_000);

test("refit rejects missing, uneligible, mismatched and drifted chosen evidence/data/dependencies before freeze", async () => {
 const f = await fixture(); const originalTag = tagMessage(f.solutionsRoot, "champion")!;
 const chosen = JSON.parse(originalTag.message);
 for (const changed of [{ ...chosen, experimentId: "missing" }, { ...chosen, pipeline: { ...chosen.pipeline, estimatorParams: { model__C: 123 } } }]) {
  tagCommit(f.solutionsRoot, "champion", f.head, JSON.stringify(changed), true);
  await expect(prepareRefit(f.options)).rejects.toThrow();
 }
 tagCommit(f.solutionsRoot, "champion", f.head, originalTag.message, true);
 await expect(prepareRefit({ ...f.options, environmentFingerprint: "drift" })).rejects.toThrow("fingerprint drifted");
 await expect(prepareRefit({ ...f.options, trainingRoot: join(f.root, "other") })).rejects.toThrow("disagrees");
 const oofPath = join(f.started.directory, "oof_predictions.csv"); const originalOof = readFileSync(oofPath);
 writeFileSync(oofPath, originalOof.toString().replace(/;0;/, ";1;"));
 await expect(prepareRefit(f.options)).rejects.toThrow(); writeFileSync(oofPath, originalOof);
 const checkpointPath = join(f.started.directory, "single-checkpoint.json"); const checkpoint = readFileSync(checkpointPath);
 const corruptCheckpoint = JSON.parse(checkpoint.toString()); corruptCheckpoint.checkpointSha256 = "0".repeat(64);
 writeFileSync(checkpointPath, JSON.stringify(corruptCheckpoint));
 await expect(prepareRefit(f.options)).rejects.toThrow("checkpoint"); writeFileSync(checkpointPath, checkpoint);
 const resultPath = join(f.started.directory, "trial-result.json"); const saved = readFileSync(resultPath);
 const changed = JSON.parse(saved.toString()); changed.promotionEligible = false; writeFileSync(resultPath, JSON.stringify(changed));
 await expect(prepareRefit(f.options)).rejects.toThrow("eligible"); writeFileSync(resultPath, saved);
 writeFileSync(f.options.testZip, "corrupt");
 await expect(prepareRefit(f.options)).rejects.toThrow();
 expect(git(f.solutionsRoot, ["tag", "-d", "champion"]).status).toBe(0);
 await expect(prepareRefit(f.options)).rejects.toThrow("No authoritative");
}, 90_000);

test("opaque terminal fit cancellation retains freeze, retries same identity, and refuses later development fits", async () => {
 const f = await fixture(2);
 const controller = new AbortController();
 const promise = runRefit({ ...f.options, signal: controller.signal });
 const prepared = await prepareRefit(f.options);
 expect(await until(() => existsSync(join(prepared.directory, "events.jsonl")) && readFileSync(join(prepared.directory, "events.jsonl"), "utf8").includes('terminal_fit'))).toBe(true);
 controller.abort(new Error("fixture cancellation"));
 await expect(promise).rejects.toThrow("fixture cancellation");
 expect(existsSync(prepared.terminalPath)).toBe(true);
 expect(existsSync(join(prepared.directory, "result.json"))).toBe(false);
 await runRefit(f.options);
 expect(JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt).toBe(2);
 const training = createHarnessTraining({ root: join(f.root, "new"), env: trainingEnvironment(), pythonExecutable: PYTHON, projectRoot: f.options.projectRoot,
  solutionsRoot: f.solutionsRoot, taskId: "fixture", datasetSha256: f.datasetSha256, rootSeed: 13, zipPath: f.zipPath, labelsPath: f.labelsPath, prompts: loadPromptSnapshot(), workerPath: WORKER });
 try { await expect(training.service.start(f.request)).rejects.toThrow("terminal"); } finally { await training.close(); }
 expect(f.events.some(e => e.type === "experiment_stop_requested")).toBe(true);
}, 90_000);


test("search winner reaches terminal refit only through its exact fixed measured confirmation", async () => {
 const f = await fixture(0, true);
 const frozen = await prepareRefit(f.options);
 expect(frozen.pipeline).toEqual(f.request.pipeline);
 expect(Object.keys(frozen.pipeline.estimatorParams!)).toContain("model__C");
 expect(frozen.chosenExperimentId).toBe(f.started.id);
 const output = await runRefit(f.options);
 expect(output.validation.valid).toBe(true);
}, 90_000);

test("service death reattaches the owned terminal worker without a duplicate fit", async () => {
 const f = await fixture(0, false, true);
 const prepared = await prepareRefit(f.options);
 const inputPath = join(f.options.projectRoot, "refit-options.json");
 const { report, ...options } = f.options;
 writeFileSync(inputPath, JSON.stringify(options));
 const child = spawn(process.execPath, [join(import.meta.dir, "fixtures-live.ts"), inputPath], { env: trainingEnvironment(), stdio: "ignore" });
 try {
  expect(await until(() => existsSync(join(prepared.directory, "events.jsonl")) && readFileSync(join(prepared.directory, "events.jsonl"), "utf8").includes('terminal_fit'))).toBe(true);
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const resumed = runRefit(f.options);
  const reattached = await until(() => f.events.some(event => event.type === "experiment_reattached"), 15000);
  writeFileSync(join(f.options.projectRoot, "refit-release"), "released");
  await resumed;
  expect(reattached).toBe(true);
  expect(JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt).toBe(1);
  expect(readFileSync(join(prepared.directory, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"type":"action_started"') && line.includes('terminal_fit'))).toHaveLength(1);
  expect(f.events.some(event => event.type === "experiment_reattached")).toBe(true);
 } finally { writeFileSync(join(f.options.projectRoot, "refit-release"), "released"); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}, 90_000);

test("dead opaque worker restarts from the same freeze and concurrent invocation cannot duplicate it", async () => {
 const f = await fixture(0, false, true);
 const prepared = await prepareRefit(f.options);
 const inputPath = join(f.options.projectRoot, "refit-options.json");
 const { report, ...options } = f.options; writeFileSync(inputPath, JSON.stringify(options));
 const child = spawn(process.execPath, [join(import.meta.dir, "fixtures-live.ts"), inputPath], { env: trainingEnvironment(), stdio: "ignore" });
 expect(await until(() => existsSync(join(prepared.directory, "events.jsonl")) && readFileSync(join(prepared.directory, "events.jsonl"), "utf8").includes('terminal_fit'))).toBe(true);
 const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
 const { ownedProcessAlive, liveGroup } = await import("../experiments/ownership.js");
 const owner = JSON.parse(readFileSync(join(prepared.directory, "worker", "worker-owner.json"), "utf8"));
 expect(ownedProcessAlive(owner.identity)).toBe(true);
 process.kill(-owner.identity.pgid, "SIGKILL");
 expect(await until(() => liveGroup(owner.identity.pgid).length === 0)).toBe(true);
 expect(existsSync(join(prepared.directory, "result.json"))).toBe(false);
 const frozenHash = hashFile(prepared.terminalPath);
 const resumed = runRefit(f.options);
 expect(await until(() => existsSync(join(prepared.directory, "attempt.json")) && JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt === 2)).toBe(true);
 try { await expect(runRefit(f.options)).rejects.toThrow("owned by another service"); } finally { writeFileSync(join(f.options.projectRoot, "refit-release"), "released"); }
 await resumed;
 expect(hashFile(prepared.terminalPath)).toBe(frozenHash);
 expect(JSON.parse(readFileSync(join(prepared.directory, "attempt.json"), "utf8")).attempt).toBe(2);
 expect(JSON.parse(readFileSync(join(prepared.directory, "result.json"), "utf8")).fitCalls).toBe(1);
}, 90_000);

test("authoritative chosen tag wins when a different eligible trial has a higher score", async () => {
 const f = await fixture();
 writeFileSync(join(f.solutionsRoot, "tasks", "fixture.py"), "from sklearn.dummy import DummyClassifier\ndef build_pipeline(context):\n    return DummyClassifier(strategy='most_frequent')\n");
 const chosenCommit = commitAll(f.solutionsRoot, "Explicit chosen baseline");
 const training = createHarnessTraining({ root: f.root, env: trainingEnvironment(), pythonExecutable: PYTHON, projectRoot: f.options.projectRoot,
  solutionsRoot: f.solutionsRoot, taskId: "fixture", datasetSha256: f.datasetSha256, rootSeed: 13, zipPath: f.zipPath, labelsPath: f.labelsPath,
  prompts: loadPromptSnapshot(), workerPath: WORKER, environmentFingerprint: f.options.environmentFingerprint, limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 const request = { ...f.request, pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", estimatorParams: { strategy: "most_frequent" } } };
 const selected = await training.service.start(request);
 expect(await until(() => training.supervisor.status(selected.id).status !== "running")).toBe(true);
 await training.service.finalize(selected.id); await training.close();
 expect((await collectTrainingResults(f.root)).selected?.experimentId).toBe(f.started.id);
 tagCommit(f.solutionsRoot, "champion", chosenCommit, JSON.stringify({ experimentId: selected.id, pipeline: request.pipeline, trainingRoot: f.root }), true);
 const frozen = await prepareRefit(f.options);
 expect(frozen.chosenExperimentId).toBe(selected.id); expect(frozen.source.commit).toBe(chosenCommit);
 await runRefit(f.options);
 expect(readFileSync(join(frozen.directory, "predictions.csv"), "utf8").trim().split(/\r?\n/).slice(1).every(line => line.endsWith(",0"))).toBe(true);
}, 90_000);
