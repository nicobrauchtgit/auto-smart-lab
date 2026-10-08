import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createHarnessTraining } from "./index.js";
import { collectTrainingTrial } from "./results.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "./testing.js";
import { tagMessage } from "./git.js";
import { runRefit } from "../refit/service.js";
import { parseTaskConfiguration } from "../pipeline/task_configuration.js";
import type { MeasurementConfig } from "./types.js";

const PIPELINE = `
import numpy as np
import zipfile
from sklearn.base import BaseEstimator
class Detector(BaseEstimator):
    def __init__(self, quality=0, random_state=None):
        self.quality = quality
        self.random_state = random_state
    def fit(self, frame, y=None):
        assert y is None and not frame.attrs, "Scoring evidence must not enter fit"
        return self
    def score_samples(self, frame):
        assert not frame.attrs
        values = []
        for item in frame.input:
            with zipfile.ZipFile(item['archive']) as archive:
                values.append(float(b'prize' in archive.read(item['member'])))
        return np.asarray(values) * (1 if self.quality else -1)
    def predict(self, frame):
        return np.where(self.score_samples(frame) > 0, -1, 1)
def build_pipeline(context):
    assert 'evidence' not in context.get('measurement', {})
    detector = Detector()
    if context.get('parameters', {}).get('scoreOnly'):
        detector.predict = None
    return detector
`;

const CONFIG = parseTaskConfiguration({ schemaVersion: 1, kind: "anomaly_detection", samples: { source: "zip_members", train: "train.zip", test: "test.zip" },
 targets: { kind: "none" }, execution: "inductive", holdout: "none", metric: "none",
 anomaly: { scoreMethod: "score_samples", scoreDirection: "higher_is_anomalous", anomalyLabel: -1 },
 selection: { basis: "evidence", metric: "evidence_average_precision", direction: "maximize", population: "development" },
 refit: "fit_training_predict_test", submission: { format: "id_semicolon_prediction", predictions: "binary" } });

test("growing evidence is snapshotted; search, paired champion, recovery, validation and refit share its score", async () => {
 const project = temporaryProject("evidence-selection-");
 const corpus = project;
 const labels = readFileSync(corpus.labelsPath, "utf8").trim().split("\n").map(line => ({ id: line.split(";")[0], target: Number(line.split(";")[1]) }));
 const manifest = join(project.root, "samples.json");
 writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, samples: labels.map(row => ({ id: row.id, input: { archive: corpus.zipPath, member: row.id } })) }));
 const liveEvidence = join(project.root, "evidence.json");
 const measurement: MeasurementConfig = { kind: "anomaly_detection", execution: "inductive", sampleManifestPath: manifest, ...CONFIG.anomaly!,
  selection: CONFIG.selection!, evidence: { path: liveEvidence, source: "agent_provided" } };
 writeFileSync(join(project.solutionsRoot, "tasks/fixture.py"), PIPELINE);
 commitAll(project.solutionsRoot, "anomaly detector with scoring-only evidence");
 const root = join(project.root, "training");
 const datasetSha256 = createHash("sha256").update(readFileSync(corpus.zipPath)).update(readFileSync(manifest)).digest("hex");
 const options = { root, projectRoot: project.root, solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON, env: trainingEnvironment(), environmentFingerprint: "fixture-environment",
  taskId: "fixture", datasetSha256, rootSeed: 13, zipPath: corpus.zipPath, measurement, workerPath: WORKER, prompts: loadPromptSnapshot(), limits: { sampleIntervalMs: 25 } };
 const training = createHarnessTraining(options);
 const request = { schemaVersion: 2, hypothesis: "rank independently labelled examples", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", estimatorParams: { quality: 0 } },
  cv: { kind: "builtin", scheme: "kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } };
 let championDirectory = "";
 try {
  // Missing agent-created evidence is acceptable at setup, required at acceptance.
  await training.service.ready();
  await expect(training.service.start(request)).rejects.toThrow();
  writeFileSync(liveEvidence, JSON.stringify({ schemaVersion: 1, labels: labels.slice(0, 48) }));
  const first = await training.service.start(request);
  expect(await until(() => training.supervisor.status(first.id).status !== "running")).toBe(true);
  await training.service.finalize(first.id);
  const firstBytes = readFileSync(join(first.directory, "evidence.json"), "utf8");
  expect(JSON.parse(tagMessage(project.solutionsRoot, "champion/fixture")!.message).experimentId).toBe(first.id);
  const scoreOnly = await training.service.start({ ...request, pipeline: { ...request.pipeline, parameters: { scoreOnly: true } }, scope: { kind: "pilot", maxFolds: 1 } });
  expect(await until(() => training.supervisor.status(scoreOnly.id).status !== "running")).toBe(true);
  const advisory = await collectTrainingTrial(scoreOnly.directory);
  expect(advisory.valid).toBe(true);
  expect(advisory.result).toMatchObject({ status: "completed", promotionEligible: false });
  // New evidence changes neither old measurements nor their durable base identity.
  writeFileSync(liveEvidence, JSON.stringify({ schemaVersion: 1, labels }));
  const search = await training.service.start({ ...request, pipeline: { module: request.pipeline.module, factory: request.pipeline.factory }, search: { space: { quality: { type: "categorical", choices: [0, 1] } }, sampler: "grid" } });
  expect(await until(() => training.supervisor.status(search.id).status !== "running")).toBe(true);
  const searchTrial = await collectTrainingTrial(search.directory);
  expect(searchTrial.errors).toEqual([]);
  expect(searchTrial.result).toMatchObject({ status: "completed", promotionEligible: false, metrics: { selectionScore: 1 } });
  const challenger = await training.service.start({ ...request, pipeline: { ...request.pipeline, estimatorParams: { quality: 1 } } });
  expect(await until(() => training.supervisor.status(challenger.id).status !== "running")).toBe(true);
  await training.service.finalize(challenger.id);
  const trial = await collectTrainingTrial(challenger.directory);
  expect(trial.errors).toEqual([]);
  expect(trial.result).toMatchObject({ status: "completed", promotionEligible: true, metrics: { selectionScore: 1 }, championComparison: { status: "completed", leadExceedsNoise: true, metric: "selectionScore" } });
  expect(readFileSync(join(first.directory, "evidence.json"), "utf8")).toBe(firstBytes);
  expect(JSON.parse(tagMessage(project.solutionsRoot, "champion/fixture")!.message).selection.evidenceSha256).toBe((trial.invocation!.measurement as any).evidenceManifestSha256);
  championDirectory = challenger.directory;
  // Validation must reject missing/NaN values, false coverage and snapshot changes.
  const foldsPath = join(challenger.directory, "fold-results.jsonl");
  const original = readFileSync(foldsPath, "utf8");
  const folds = original.trim().split("\n").map(line => JSON.parse(line));
  for (const mutate of [(fold: any) => delete fold.metrics.selectionScore, (fold: any) => fold.selection.value = null, (fold: any) => fold.selection.labelCoverage = 0]) {
   const changed = structuredClone(folds); mutate(changed[0]);
   writeFileSync(foldsPath, changed.map(fold => JSON.stringify(fold)).join("\n") + "\n");
   expect((await collectTrainingTrial(challenger.directory)).valid).toBe(false);
  }
  writeFileSync(foldsPath, original);
  // Both summary copies may agree while carrying corrupted provenance;
  // they still must match the invocation and authoritative fold receipts.
  const resultPath = join(challenger.directory, "trial-result.json");
  const metricsPath = join(challenger.directory, "metrics.json");
  const resultBytes = readFileSync(resultPath, "utf8");
  const metricsBytes = readFileSync(metricsPath, "utf8");
  for (const mutate of [(selection: any) => selection.basis = "proxy", (selection: any) => selection.source = "trusted", (selection: any) => selection.evidenceSha256 = "0".repeat(64), (selection: any) => selection.folds = []]) {
   const changed = JSON.parse(resultBytes); mutate(changed.selection);
   writeFileSync(resultPath, JSON.stringify(changed)); writeFileSync(metricsPath, JSON.stringify(changed));
   expect((await collectTrainingTrial(challenger.directory)).valid).toBe(false);
  }
  writeFileSync(resultPath, resultBytes); writeFileSync(metricsPath, metricsBytes);
  const falseCoverageFolds = structuredClone(folds);
  falseCoverageFolds[0].validationRows *= 2;
  falseCoverageFolds[0].selection.validationRows *= 2;
  falseCoverageFolds[0].selection.labelCoverage /= 2;
  const falseCoverageResult = JSON.parse(resultBytes);
  falseCoverageResult.selection.folds = falseCoverageFolds.map((fold: any) => fold.selection);
  writeFileSync(foldsPath, falseCoverageFolds.map(fold => JSON.stringify(fold)).join("\n") + "\n");
  writeFileSync(resultPath, JSON.stringify(falseCoverageResult)); writeFileSync(metricsPath, JSON.stringify(falseCoverageResult));
  expect((await collectTrainingTrial(challenger.directory)).valid).toBe(false);
  writeFileSync(foldsPath, original); writeFileSync(resultPath, resultBytes); writeFileSync(metricsPath, metricsBytes);
  const snapshotPath = join(challenger.directory, "evidence.json");
  const originalEvidence = readFileSync(snapshotPath, "utf8");
  writeFileSync(snapshotPath, "{}");
  expect((await collectTrainingTrial(challenger.directory)).valid).toBe(false);
  writeFileSync(snapshotPath, originalEvidence);
  rmSync(liveEvidence);
 } finally { await training.close(); }
 // Changing AP to ROC must rerun the existing champion under the new objective;
 // a worse challenger cannot become a fresh "first" champion merely by changing basis.
 writeFileSync(liveEvidence, JSON.stringify({ schemaVersion: 1, labels }));
 const transition = createHarnessTraining({ ...options, root: join(project.root, "roc-training"), measurement: { ...measurement, selection: { ...CONFIG.selection!, metric: "evidence_roc_auc" } } as MeasurementConfig });
 try {
  const started = await transition.service.start(request);
  expect(await until(() => transition.supervisor.status(started.id).status !== "running")).toBe(true);
  await transition.service.finalize(started.id);
  const result = (await collectTrainingTrial(started.directory)).result;
  expect(result).toMatchObject({ status: "completed", championComparison: { status: "completed", meanDifference: -1, selection: { metric: "evidence_roc_auc" } } });
  expect(JSON.parse(tagMessage(project.solutionsRoot, "champion/fixture")!.message).experimentId).toBe(JSON.parse(readFileSync(join(championDirectory, "trial-result.json"), "utf8")).experimentId);
 } finally { await transition.close(); }
 rmSync(liveEvidence);
 // Recovery must use trial snapshots even after the mutable file disappears.
 const resumed = createHarnessTraining(options);
 try { await resumed.service.ready(); } finally { await resumed.close(); }
 expect((await collectTrainingTrial(championDirectory)).eligible).toBe(true);
 const testZip = join(project.root, "test.zip");
 execFileSync(PYTHON, ["-c", "import zipfile,sys; a=zipfile.ZipFile(sys.argv[1],'w'); a.writestr('test/a.x','limited prize'); a.writestr('test/b.x','meeting agenda'); a.close()", testZip]);
 const terminal = await runRefit({ taskId: "fixture", projectRoot: project.root, solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON,
  taskConfiguration: CONFIG, trainZip: corpus.zipPath, testZip, environmentFingerprint: "fixture-environment", env: trainingEnvironment() });
 expect(terminal.validation.valid).toBe(true);
 expect(JSON.parse(readFileSync(terminal.artifacts.find(a => a.kind === "terminal_refit_result")!.path, "utf8"))).toMatchObject({ fitCalls: 1, trainRows: 120, testRows: 2 });
}, 120_000);
