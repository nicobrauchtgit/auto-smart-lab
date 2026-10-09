import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runConfirmation } from "./service.js";
import { confirmedCandidate } from "./receipt.js";
import { createHarnessTraining, collectTrainingResults } from "../training/index.js";
import { temporaryProject, writeCorpus, writeSampleManifest, PYTHON, WORKER, until, trainingEnvironment, commitAll } from "../training/testing.js";
import { createSeedPlan } from "../training/seeds.js";
import { digest } from "../training/terminal.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { prepareSolveSandbox, trainingSandboxCommand } from "../run/solve_sandbox.js";
import { prepareRefit, runRefit } from "../refit/service.js";
import { prepareEvidence } from "../evaluation/evidence.js";
import { tagMessage, tagCommit } from "../training/git.js";
import { runHarnessSolveSession } from "../run/harness_solve_session.js";
import type { SolveWorkspace } from "../solve/workspace.js";

async function fixture(delay = 0, leak = false, barrier = false) {
 const p = temporaryProject("holdout-confirmation-");
 const python = readPythonEnvironment();
 const samples = writeSampleManifest(p.root, p.zipPath, p.labelsPath);
 const fullRoot = join(p.root, "full"); mkdirSync(fullRoot);
 const full = writeCorpus(fullRoot, 140);
 const testZip = join(p.root, "test.zip");
 execFileSync(PYTHON, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('test/one.x','prize winner'); z.writestr('test/two.x','project meeting'); z.close()", testZip]);
 const ids = readFileSync(full.labelsPath, "utf8").trim().split("\n").slice(120).map(line => line.split(";")[0]);
 const devIds = JSON.parse(readFileSync(samples.sampleManifestPath, "utf8")).samples.map((row: any) => row.id);
 const features = join(p.solutionsRoot, "features.py");
 writeFileSync(features, readFileSync(features, "utf8").replace('        if self.delay:', `        if len(frame) == 120:\n            from pathlib import Path\n            assert not Path(${JSON.stringify(full.labelsPath)}).exists(), 'full targets exposed to model'\n            assert not Path(${JSON.stringify(full.zipPath)}).exists(), 'full archive exposed to model'\n            assert set(frame['id']) == set(${JSON.stringify(devIds)}), 'sealed rows entered fit'\n        if self.delay:`));
 if (barrier) writeFileSync(features, readFileSync(features, "utf8").replace('        if self.delay:', `        if len(frame) == 120:\n            from pathlib import Path\n            while not Path(${JSON.stringify(join(p.root, "runs/fixture/solve/agent/release"))}).exists():\n                time.sleep(.05)\n        if self.delay:`));
 if (leak) {
  writeFileSync(join(p.solutionsRoot, "tasks/fixture.py"), `from sklearn.base import BaseEstimator\nclass Model(BaseEstimator):\n    def fit(self, frame, y):\n        self.confirming = len(frame) == 120\n        return self\n    def predict(self, frame):\n        if self.confirming:\n            return [int(str(value).endswith('.1')) for value in frame.id]\n        import zipfile\n        return [int(b'prize' in zipfile.ZipFile(item['archive']).read(item['member'])) for item in frame.input]\ndef build_pipeline(context):\n    return Model()\n`);
 }
 const commit = commitAll(p.solutionsRoot, "Verify confirmation data boundary");
 const root = join(p.root, "runs/fixture/solve"); mkdirSync(join(root, "research"), { recursive: true });
 const taskPath = join(root, "task.md"); writeFileSync(taskPath, "Binary classification fixture");
 const workspace: SolveWorkspace = { root, solutionsRoot: p.solutionsRoot, entrypointPath: join(p.solutionsRoot, "tasks/fixture.py"), taskPath,
  researchDir: join(root, "research"), configuration: spamConfiguration(), sampleManifestPath: samples.sampleManifestPath, measurement: samples.measurement,
  devZip: p.zipPath, trainZip: full.zipPath, testZip, originalTargetsPath: full.labelsPath, sealedPath: join(root, "sealed.txt"), datasetPaths: [p.zipPath, testZip],
  split: { scheme: "stratified", sealedIds: ids, fraction: 20 / 140, seed: 13, sha256: digest(ids), confirmation: { precision: "target", rows: 20, perClass: { "0": 10, "1": 10 } } },
  holdoutSeedPlan: createSeedPlan({ rootSeed: 13, taskId: "fixture", datasetSha256: full.datasetSha256, experimentId: "holdout-split" }),
  recommendation: { scheme: "stratified_kfold", folds: 2, repeats: 1, rationale: "fixture" }, rowCount: 120, targets: samples.sampleManifestPath, targetSummary: "balanced", researchState: "fixture" };
 mkdirSync(join(root, "data")); writeFileSync(join(root, "data/holdout.json"), JSON.stringify(workspace.split));
 const policy = prepareSolveSandbox(workspace, python);
 const trainingRoot = join(root, "training/initial");
 const training = createHarnessTraining({ root: trainingRoot, projectRoot: p.root, solutionsRoot: p.solutionsRoot, pythonExecutable: PYTHON,
  env: trainingEnvironment(), environmentFingerprint: python.fingerprint, taskId: "fixture", datasetSha256: samples.datasetSha256,
  rootSeed: 13, zipPath: p.zipPath, measurement: samples.measurement, workerPath: WORKER, prompts: loadPromptSnapshot(), limits: { sampleIntervalMs: 25 } });
 const request = { schemaVersion: 2, hypothesis: "frozen fixture", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", ...(delay ? { parameters: { delay } } : {}) },
  cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } };
 const started = await training.service.start(request);
 expect(await until(() => training.supervisor.status(started.id).status !== "running")).toBe(true);
 await training.service.finalize(started.id); await training.close();
 const refit = { taskId: "fixture", projectRoot: p.root, solutionsRoot: p.solutionsRoot, pythonExecutable: PYTHON,
  taskConfiguration: workspace.configuration, trainZip: full.zipPath, testZip, labelsPath: full.labelsPath, environmentFingerprint: python.fingerprint, env: trainingEnvironment() };
 const options = { workspace, pythonExecutable: PYTHON, environmentFingerprint: python.fingerprint, env: trainingEnvironment(),
  sandboxCommand: (command: string[], input: { directory: string; sourceRoots: readonly string[] }) => trainingSandboxCommand(policy, command, input) };
 return { p, python, workspace, options, refit, trainingRoot, started, commit, request };
}

test("closed solve confirms once, preserves hidden inputs, evaluation reads it and refit binds its identity", async () => {
 const f = await fixture();
 await expect(prepareRefit(f.refit)).rejects.toThrow("required");
 let sessionClosed = false;
 const result = await runHarnessSolveSession("fixture", undefined, { taskConfiguration: f.workspace.configuration, runId: "confirmation-session",
  report: { event() {}, input() {}, agentIdentity: () => ({ pipelineRunId: "c2-pipeline", stageInvocationId: "c2-invocation" }), observation: () => () => {} } as any,
  dependencies: { prepareWorkspace: () => f.workspace, readPython: () => f.python,
   runAgentSession: async (options: any) => { expect(options.prompt).not.toContain('holdoutConfirmation'); sessionClosed = true; return { output: "existing champion is sufficient", agentRunId: "inert" } as any; },
   confirm: async options => { expect(sessionClosed).toBe(true); return runConfirmation(options); } } });
 expect(result.valid).toBe(true);
 const record = JSON.parse(readFileSync(result.confirmation!.artifact.path, "utf8"));
 expect(record).toMatchObject({ experimentId: f.started.id, source: { commit: f.commit }, fitCalls: 1, developmentRows: 120, validationRows: 20,
  readCount: 1, metrics: { balancedAccuracy: 1 }, interval: { lower: 1, upper: 1 }, gap: 0, idLeakage: null });
 const firstBytes = readFileSync(result.confirmation!.artifact.path, "utf8");
 const workerEvents = readFileSync(join(dirname(result.confirmation!.artifact.path), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
 expect(workerEvents.every(event => event.pipelineRunId === "c2-pipeline" && event.stageInvocationId === "c2-invocation")).toBe(true);
 expect((await runConfirmation(f.options)).summary.readCount).toBe(1);
 expect(readFileSync(result.confirmation!.artifact.path, "utf8")).toBe(firstBytes);
 const ledgerPath = join(f.p.root, "runs/fixture/holdout-ledger.json");
 const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
 // Later reads lower independence without rewriting an earlier immutable receipt.
 ledger.populations[record.population].reads.push({ identity: "f".repeat(64), experimentId: "later-champion" });
 writeFileSync(ledgerPath, JSON.stringify(ledger));
 expect((await runConfirmation(f.options)).summary).toMatchObject({ readCount: 1, populationReadCount: 2 });
 const collection = await collectTrainingResults(f.trainingRoot);
 const trial = collection.trials.find(t => t.experimentId === f.started.id)!;
 const upstream = [...trial.artifacts, { ...trial.artifacts.find(a => a.kind === "training_trial_result")!, kind: "training_selected_result" }, result.confirmation!.artifact];
 const evaluated = await prepareEvidence(upstream, new AbortController().signal, "fixture");
 expect(evaluated.diagnostics.holdoutConfirmation).toMatchObject({ readCount: 1, populationReadCount: 2, metrics: { balancedAccuracy: 1 } });
 expect(evaluated.sources.some(source => source.kind === "holdout_confirmation")).toBe(true);
 const prepared = await prepareRefit(f.refit);
 expect(prepared.evidence.some(entry => entry.path === result.confirmation!.artifact.path)).toBe(true);
 const tag = tagMessage(f.p.solutionsRoot, "champion/fixture")!;
 tagCommit(f.p.solutionsRoot, "champion/fixture", f.commit, JSON.stringify({ ...JSON.parse(tag.message), experimentId: "different" }), true);
 expect(() => confirmedCandidate(f.p.root, "fixture", { ...prepared, chosenExperimentId: "different" })).toThrow("differs");
 tagCommit(f.p.solutionsRoot, "champion/fixture", f.commit, tag.message, true);
 // Terminal refit really includes the sealed rows after the confirmation-bound freeze.
 expect((await runRefit(f.refit)).validation.valid).toBe(true);
 expect(JSON.parse(readFileSync(join(prepared.directory, "result.json"), "utf8")).trainRows).toBe(140);
}, 90_000);

test("insufficient precision records a skip and consumes no sealed read", async () => {
 const f = await fixture();
 f.workspace.split = { ...f.workspace.split, sealedIds: [], fraction: 0, confirmation: { rows: 0, perClass: { "0": 0, "1": 0 }, precision: "none", reason: "too small" } };
 f.workspace.trainZip = f.p.zipPath; f.workspace.originalTargetsPath = f.p.labelsPath;
 writeFileSync(join(f.workspace.root, "data/holdout.json"), JSON.stringify(f.workspace.split));
 const output = await runConfirmation(f.options);
 expect(output.summary).toMatchObject({ status: "skipped", precision: "none", reason: "too small", readCount: 0 });
 expect(existsSync(join(f.p.root, "runs/fixture/holdout-ledger.json"))).toBe(false);
}, 60_000);

test("confirmation canary catches a model leaking only after its full-development fit", async () => {
 const f = await fixture(0, true);
 await expect(runConfirmation(f.options)).rejects.toThrow("ID leakage");
 await expect(prepareRefit(f.refit)).rejects.toThrow("valid evidence");
 const ledger = JSON.parse(readFileSync(join(f.p.root, "runs/fixture/holdout-ledger.json"), "utf8"));
 expect(Object.values(ledger.populations).flatMap((value: any) => value.reads)).toHaveLength(1);
}, 60_000);

test("cancellation consumes the attempt and never automatically fits the sealed population again", async () => {
 // Hold the confirmation fit until cancellation; a short sleep can finish
 // during the supervisor's graceful-stop interval on a loaded test run.
 const f = await fixture(0, false, true);
 const controller = new AbortController();
 const events: string[] = [];
 const pending = runConfirmation({ ...f.options, signal: controller.signal,
  report: { event: (type: string) => events.push(type), input() {}, agentIdentity: () => ({ pipelineRunId: "c2", stageInvocationId: "cancel" }), observation: () => { throw new Error("no agent"); } } as any });
 expect(await until(() => events.includes("holdout_confirmation_started"), 20000)).toBe(true);
 controller.abort(new Error("cancel fixture"));
 await expect(pending).rejects.toThrow("cancel fixture");
 await expect(runConfirmation(f.options)).rejects.toThrow("consumed");
 expect(events).toContain("experiment_stop_requested");
}, 60_000);

test("completed receipt corruption fails closed without another fit", async () => {
 const f = await fixture();
 const output = await runConfirmation(f.options);
 const directory = dirname(output.artifact.path);
 const before = readFileSync(join(directory, "events.jsonl"), "utf8");
 const record = JSON.parse(readFileSync(output.artifact.path, "utf8"));
 record.metrics.balancedAccuracy = .123;
 writeFileSync(output.artifact.path, JSON.stringify(record));
 await expect(runConfirmation(f.options)).rejects.toThrow("metrics changed");
 await expect(prepareRefit(f.refit)).rejects.toThrow("checksum changed");
 expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe(before);
}, 60_000);

test("service death reattaches the confirmation worker with one fit and one recorded read", async () => {
 const f = await fixture(0, false, true);
 const input = join(f.p.root, "confirmation-options.json");
 const { sandboxCommand, ...serializable } = f.options;
 writeFileSync(input, JSON.stringify(serializable));
 const child = spawn(process.execPath, [join(import.meta.dir, "fixture-live.ts"), input], { env: trainingEnvironment(), stdio: "ignore" });
 const root = join(f.p.root, "runs/fixture/confirmation");
 let directory = "";
 const release = join(f.workspace.root, "agent/release");
 try {
  expect(await until(() => {
   if (!existsSync(root)) return false;
   const id = readdirSync(root).find(name => /^[a-f0-9]{64}$/.test(name));
   if (!id) return false;
   directory = join(root, id);
   const path = join(directory, "events.jsonl");
   return existsSync(path) && readFileSync(path, "utf8").includes('confirmation_fit');
  }, 20000)).toBe(true);
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const events: string[] = [];
  const resumed = runConfirmation({ ...f.options, report: { event: (type: string) => events.push(type), input() {},
   agentIdentity: () => ({ pipelineRunId: "c2", stageInvocationId: "resume" }), observation: () => { throw new Error("no agent"); } } as any });
  expect(await until(() => events.includes("experiment_reattached"), 20000)).toBe(true);
  await expect(runConfirmation(f.options)).rejects.toThrow("owned by another service");
  writeFileSync(release, "released");
  const output = await resumed;
  expect(output.summary).toMatchObject({ readCount: 1, populationReadCount: 1 });
  const fits = readFileSync(join(directory, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"type":"action_started"') && line.includes('confirmation_fit'));
  expect(fits).toHaveLength(1);
 } finally {
  writeFileSync(release, "released");
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
 }
}, 60_000);
