import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TaskKnowledge } from "./service.js";
import { digest } from "./store.js";
import { createSeedPlan, deriveTrialSeed, serializeSeedPlan } from "../training/seeds.js";
import { PYTHON, WORKER, trainingEnvironment } from "../training/testing.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
for (const kind of ["clustering", "anomaly_detection"] as const) test(`${kind} notes verify actual prediction evidence without importing pipelines`, async () => {
 const root = mkdtempSync(join(tmpdir(), "knowledge-measurement-")); roots.push(root);
 const training = join(root, "training"), directory = join(training, "fixture"), solutions = join(root, "solutions");
 mkdirSync(directory, { recursive: true }); mkdirSync(solutions);
 writeFileSync(join(solutions, "model.py"), `from sklearn.base import BaseEstimator\nimport numpy as np\nclass Model(BaseEstimator):\n def fit(self,X,y=None):\n  assert y is None\n  return self\n def predict(self,X): return np.array([int(x[0]) for x in X.input])\n def score_samples(self,X): return np.array([float(x[0]) for x in X.input])\ndef build_pipeline(): return Model()\n`);
 const archive = join(root, "train.zip"), manifest = join(root, "samples.json");
 const made = spawnSync(PYTHON, ["-c", 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("placeholder","opaque")', archive], { env: trainingEnvironment(), encoding: "utf8" });
 expect(made.status).toBe(0);
 const samples = Array.from({ length: 48 }, (_, index) => ({ id: `row-${String(index).padStart(2, "0")}`, input: [index % 2], ...(kind === "clustering" ? { target: String(index % 2) } : {}) }));
 writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, samples }));
 const evidencePath = join(directory, "evidence.json");
 writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, labels: samples.map(row => ({ id: row.id, target: row.input[0] })) }));
 const measurement = { kind, execution: "inductive", sampleManifestPath: manifest, sampleManifestSha256: digest(readFileSync(manifest)), hasTargets: kind === "clustering",
  ...(kind === "anomaly_detection" ? { scoreMethod: "score_samples", scoreDirection: "higher_is_anomalous", anomalyLabel: 1,
   evidence: { path: evidencePath, source: "agent_provided" }, evidenceManifestSha256: digest(readFileSync(evidencePath)),
   selection: { basis: "evidence", metric: "evidence_average_precision", direction: "maximize", population: "development" } } : {}) };
 const datasetSha256 = digest(Buffer.concat([readFileSync(archive), readFileSync(manifest)]));
 const request = { schemaVersion: 1, hypothesis: "fixture signal", pipeline: { module: "solutions/model.py", factory: "build_pipeline" }, cv: { kind: "builtin", scheme: "kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" } };
 const seeds = createSeedPlan({ rootSeed: 17, taskId: "fixture", datasetSha256, experimentId: "fixture" });
 writeFileSync(join(directory, "seed-plan.json"), serializeSeedPlan(seeds)); writeFileSync(join(directory, "request.json"), JSON.stringify(request));
 const invocation = { schemaVersion: 1, experimentId: "fixture", request, measurement, inputs: { projectRoot: root, zipPath: archive, outputDir: directory }, seeds: { experiment: seeds.experimentSeed, trial: deriveTrialSeed(seeds, 0) } };
 writeFileSync(join(directory, "invocation.json"), JSON.stringify(invocation));
 const fit = spawnSync(PYTHON, [WORKER, "--invocation", join(directory, "invocation.json")], { env: trainingEnvironment(), encoding: "utf8", timeout: 30000 });
 if (fit.status !== 0) throw new Error(fit.stderr);
 const service = new TaskKnowledge({ root: join(root, "knowledge"), origin: { taskId: "fixture", datasetSha256 }, trainingRoots: [root] });
 const draft = { title: "Measured fixture signal", summary: "Prediction evidence was observed", body: "This is measured on the declared development population, not official accuracy.", tags: ["signal"], status: "empirical" as const, applicability: "Fixture", caveats: "No causal or transfer claim" };
 const captured = await service.capture(draft, { rootIndex: 0, run: "training", id: "fixture" });
 const note: any = await service.read(captured.id);
 expect(note.evidenceStatus).toBe("verified_historical_harness_measurement");
 expect(note.evidence.metrics).toEqual(kind === "clustering" ? { adjustedRandIndex: 1 } : { selectionScore: 1 });
 writeFileSync(join(solutions, "model.py"), 'raise RuntimeError("Do not import models during knowledge verification")');
 expect((await service.read(captured.id) as any).evidenceStatus).toBe("verified_historical_harness_measurement");
 const resultPath = join(directory, "trial-result.json"), metricsPath = join(directory, "metrics.json");
 const result = JSON.parse(readFileSync(resultPath, "utf8"));
 result.metrics[kind === "clustering" ? "adjustedRandIndex" : "selectionScore"] = .99;
 writeFileSync(resultPath, JSON.stringify(result)); writeFileSync(metricsPath, JSON.stringify(result));
 await expect(service.capture({ ...draft, title: "Fabricated signal" }, { rootIndex: 0, run: "training", id: "fixture" })).rejects.toThrow();
 expect((await service.read(captured.id) as any).evidenceStatus).toBe("stale_or_unavailable");
}, 60000);
