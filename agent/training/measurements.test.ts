import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { collectTrainingTrial } from "./results.js";
import { commitAll, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "./testing.js";
import { tagMessage } from "./git.js";
import type { MeasurementConfig } from "./types.js";

const clusteringCode = `
import numpy as np
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import FunctionTransformer
from sklearn.cluster import AgglomerativeClustering
def features(frame):
    return np.asarray(frame.input.tolist(), dtype=float)
def build_pipeline(context):
    return Pipeline([('features', FunctionTransformer(features)),
                     ('model', AgglomerativeClustering(n_clusters=context['parameters'].get('clusters', 6)))])
`;
const anomalyCode = clusteringCode.replace("from sklearn.cluster import AgglomerativeClustering", "from sklearn.ensemble import IsolationForest")
    .replace("AgglomerativeClustering(n_clusters=context['parameters'].get('clusters', 6))", "IsolationForest(n_estimators=10)");
const request = (clusters = 6, scheme = "stratified_kfold") => ({ schemaVersion: 2, hypothesis: "measure family discovery",
    pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { clusters } },
    cv: { kind: "builtin", scheme, folds: 3, repeats: 2 }, scope: { kind: "promotion" } });

function fixture(kind: "clustering" | "anomaly_detection", labelled = kind === "clustering", overrides: Record<string, unknown> = {}, maxExperiments?: number) {
    const project = temporaryProject("measurement-harness-");
    const path = join(project.root, "samples.json");
    const samples = Array.from({ length: 60 }, (_, i) => ({ id: `sample-${i.toString().padStart(3, "0")}`,
        input: [i % 6, i % 6], ...(labelled ? { target: `family-${i % 6}` } : {}) }));
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, samples }));
    writeFileSync(join(project.solutionsRoot, "tasks/fixture.py"), kind === "clustering" ? clusteringCode : anomalyCode);
    project.head = commitAll(project.solutionsRoot, "Generic measurement fixture");
    const measurement: MeasurementConfig = kind === "clustering"
        ? { kind, execution: "batch", sampleManifestPath: path }
        : { kind, execution: "inductive", sampleManifestPath: path, scoreMethod: "score_samples", scoreDirection: "lower_is_anomalous", anomalyLabel: -1 };
    Object.assign(measurement, overrides);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const training = createHarnessTraining({ root: join(project.root, "training"), projectRoot: project.root,
        solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON, env: trainingEnvironment(),
        taskId: "fixture", datasetSha256: createHash("sha256").update(readFileSync(path)).digest("hex"), rootSeed: 13,
        measurement, workerPath: WORKER, prompts: loadPromptSnapshot(),
        maxExperiments,
        pipelineRunId: "measurement-run", stageInvocationId: "measurement-invocation",
        record: (type, payload) => events.push({ type, payload }), limits: { sampleIntervalMs: 25 } });
    return { project, training, measurement, events, path };
}

async function finish(training: ReturnType<typeof createHarnessTraining>, started: { id: string; directory: string }) {
    expect(await until(() => training.supervisor.status(started.id).status !== "running")).toBe(true);
    await training.service.finalize(started.id);
    return JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
}

test("batch clustering without predict() produces valid ARI evidence, stability, and paired champion error changes", async () => {
    const { project, training, events } = fixture("clustering");
    try {
        const baseline = await training.service.start(request(2));
        expect((await finish(training, baseline)).promotionEligible).toBe(true);
        const challenger = await training.service.start(request());
        const result = await finish(training, challenger);
        expect(result.status).toBe("completed");
        expect(result.metrics.adjustedRandIndex).toBe(1);
        expect(result.championComparison.metric).toBe("adjustedRandIndex");
        expect(result.championComparison.correctedPairs).toBeGreaterThan(0);
        expect(result.championComparison.introducedPairs).toBe(0);
        expect(result.championComparison.leadExceedsNoise).toBe(true);
        expect(result.diagnostics.stability.summary.mean).toBe(1);
        const collected = await collectTrainingTrial(challenger.directory);
        expect(collected.errors).toEqual([]);
        expect(collected.eligible).toBe(true);
        expect(collected.artifacts.find(a => a.kind === "training_trial_result")?.sha256).toHaveLength(64);
        const description = training.service.describe(challenger.id) as any;
        expect(description.diagnostics.folds[0].diagnostics.external.contingency).toBeUndefined();
        expect(description.diagnostics.championComparison.correctedPairs).toBe(result.championComparison.correctedPairs);
        expect(training.service.leaderboard().at(-1)?.adjustedRandIndex).toBe(1);
        expect(JSON.parse(tagMessage(project.solutionsRoot, "champion")!.message).experimentId).toBe(challenger.id);
        expect(events.some(e => e.type === "training_measurement_setup" && e.payload.ok === true)).toBe(true);
        const workerEvents = readFileSync(join(challenger.directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(workerEvents.every(e => e.pipelineRunId === "measurement-run" && e.stageInvocationId === "measurement-invocation")).toBe(true);
    } finally { await training.close(); }
}, 45000);

test("label-free anomaly execution succeeds with advisory diagnostics and cannot acquire promotion eligibility", async () => {
    const { training } = fixture("anomaly_detection");
    try {
        const started = await training.service.start(request(6, "kfold"));
        const result = await finish(training, started);
        expect(result.status).toBe("completed");
        expect(result.promotionEligible).toBe(false);
        expect(result.diagnostics.proxyEvidence).toBe(true);
        expect(result.diagnostics.folds[0].diagnostics.thresholdSensitivity.available).toBe(true);
        expect((await collectTrainingTrial(started.directory)).valid).toBe(true);
        const status = training.service.describe(started.id) as any;
        expect(status.diagnostics.proxyEvidence).toBe(true);
        expect(status.diagnostics.stability.available).toBe(true);
        for (const name of ["trial-result.json", "metrics.json"]) {
            writeFileSync(join(started.directory, name), JSON.stringify({ ...result, promotionEligible: true }));
        }
        const corrupted = await collectTrainingTrial(started.directory);
        expect(corrupted.eligible).toBe(false);
        expect(corrupted.errors.some(e => e.code === "invalid_promotion_eligibility")).toBe(true);
    } finally { await training.close(); }
}, 30000);

test("clustering searches and their fixed confirmation reuse the same measurement execution path", async () => {
    const { training } = fixture("clustering");
    try {
        const pilot = await training.service.start({ ...request(), scope: { kind: "pilot", maxRows: 30, maxFolds: 1 } });
        expect((await finish(training, pilot)).status).toBe("completed");
        const pilotFold = JSON.parse(readFileSync(join(pilot.directory, "fold-results.jsonl"), "utf8").trim());
        const started = await training.service.start({ ...request(), pipeline: { ...request().pipeline, parameters: {} },
            search: { sampler: "grid", space: { "factory.clusters": { type: "categorical", choices: [2, 6] } } } });
        const invocation = JSON.parse(readFileSync(join(started.directory, "invocation.json"), "utf8"));
        expect(invocation.runtime.priorTrainRows).toBe(pilotFold.fitRows);
        expect(invocation.runtime.priorTrainRows).not.toBe(pilotFold.trainRows);
        const searched = await finish(training, started);
        expect(searched.status).toBe("completed");
        expect(searched.promotionEligible).toBe(false);
        expect(searched.metrics.adjustedRandIndex).toBe(1);
        expect((await collectTrainingTrial(started.directory)).valid).toBe(true);
        const report = JSON.parse(readFileSync(join(started.directory, "search-report.json"), "utf8"));
        const confirmed = await training.service.start(report.nextStep.confirmationRequest);
        const result = await finish(training, confirmed);
        expect(result.status).toBe("completed");
        expect(result.promotionEligible).toBe(true);
        expect(result.metrics.adjustedRandIndex).toBe(1);
    } finally { await training.close(); }
}, 45000);

test("missing score direction fails setup and label-free search consumes no trial budget", async () => {
    const invalid = fixture("anomaly_detection", false, { scoreDirection: undefined });
    try {
        await expect(invalid.training.ready()).rejects.toThrow("scoreDirection");
        expect(invalid.training.supervisor.list()).toHaveLength(0);
    } finally { await invalid.training.close(); }
    const valid = fixture("anomaly_detection", false, {}, 1);
    try {
        await expect(valid.training.service.start({ ...request(6, "kfold"), pipeline: { ...request().pipeline, parameters: {} }, search: { sampler: "grid", space: {
            "factory.clusters": { type: "categorical", choices: [2, 6] } } } })).rejects.toThrow("no trusted primary metric");
        expect(valid.training.supervisor.list()).toHaveLength(0);
        const started = await valid.training.service.start(request(6, "kfold"));
        await expect(valid.training.service.start(request(6, "kfold"))).rejects.toThrow("budget exhausted");
        expect((await finish(valid.training, started)).status).toBe("completed");
    } finally { await valid.training.close(); }
}, 30000);

test("label-free geometry search has an explicit proxy objective, retained feature diagnostics, and no champion", async () => {
    const { training, project } = fixture("clustering", false);
    try {
        const started = await training.service.start({ ...request(6, "kfold"), pipeline: { ...request().pipeline, parameters: {} },
            diagnostics: { representation: { source: "pipeline_features", metric: "euclidean", dbcv: true } },
            search: { sampler: "grid", objective: { kind: "proxy", metric: "silhouette", direction: "maximize" },
                space: { "factory.clusters": { type: "categorical", choices: [2, 6] } } } });
        const result = await finish(training, started);
        expect(result.status).toBe("completed");
        expect(result.metrics).toBeNull();
        expect(result.search.proxyEvidence).toBe(true);
        expect(result.search.selectionMean).toBe(1);
        expect(result.diagnostics.folds[0].diagnostics.geometry.silhouette.available).toBe(true);
        expect((await collectTrainingTrial(started.directory)).valid).toBe(true);
        expect(tagMessage(project.solutionsRoot, "champion")).toBeUndefined();
        const report = JSON.parse(readFileSync(join(started.directory, "search-report.json"), "utf8"));
        const confirmed = await training.service.start(report.nextStep.confirmationRequest);
        expect((await finish(training, confirmed)).promotionEligible).toBe(false);
        expect((await collectTrainingTrial(confirmed.directory)).eligible).toBe(false);
    } finally { await training.close(); }
}, 45000);

test("metadata edits after readiness cannot silently change a trial's dataset", async () => {
    const { training, path } = fixture("clustering");
    try {
        await training.ready();
        const metadata = JSON.parse(readFileSync(path, "utf8")); metadata.samples[0].input = [1000, 1000];
        writeFileSync(path, JSON.stringify(metadata));
        await expect(training.service.start(request())).rejects.toThrow("changed after setup");
        expect(training.supervisor.list()).toHaveLength(0);
    } finally { await training.close(); }
});

test.each(["missing", "duplicate", "invalid-target"])("measurement preflight rejects %s prerequisites before any worker or agent import", async failure => {
    const { training, path, events, project } = fixture("clustering");
    writeFileSync(join(project.solutionsRoot, "tasks/fixture.py"), "raise RuntimeError('agent imported before setup')\n");
    if (failure === "missing") {
        const { unlinkSync } = await import("node:fs"); unlinkSync(path);
    } else if (failure === "duplicate") {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, samples: [{ id: "same", input: [] }, { id: "same", input: [] }] }));
    } else {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, samples: [{ id: "a", input: [], target: true }, { id: "b", input: [], target: false }] }));
    }
    try {
        await expect(training.ready()).rejects.toThrow("Measurement setup failed");
        expect(training.supervisor.list()).toHaveLength(0);
        expect(events.some(e => e.type === "training_measurement_setup" && e.payload.ok === false)).toBe(true);
    } finally { await training.close(); }
});
