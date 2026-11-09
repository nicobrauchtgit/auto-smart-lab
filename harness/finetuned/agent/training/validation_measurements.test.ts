import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { createHarnessTraining } from "./index.js";
import { collectTrainingTrial } from "./results.js";
import { compactDiagnostics } from "./service.js";
import { commitAll, PIPELINE_MODULE, PYTHON, temporaryProject, trainingEnvironment, until, WORKER } from "./testing.js";

const code = PIPELINE_MODULE.replace("def build_pipeline(context):", `
import numpy as np
class DiagnosticPipeline(Pipeline):
    def fit(self, frame, y=None, **kwargs):
        assert not frame.attrs
        self.fit_ids = set(frame.id)
        return super().fit(frame, y, **kwargs)
    def predict(self, frame, **kwargs):
        assert not self.fit_ids.intersection(frame.id)
        return super().predict(frame, **kwargs)
    def diagnostic_slices(self, frame):
        return {"all": np.ones(len(frame), dtype=bool),
                "offers": np.array(["prize" in text for text in TextColumn().transform(frame)]),
                "empty": np.zeros(len(frame), dtype=bool)}
    def diagnostic_changes(self, frame, context):
        changed = frame.copy()
        import zipfile
        path = frame["input"].iloc[0]["archive"] + ".perturbed.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for descriptor in frame["input"]:
                archive.writestr(descriptor["member"], "unknown words")
        changed["input"] = [{"archive": path, "member": item["member"]} for item in frame["input"]]
        return [{"name": "identity", "frame": frame.copy(), "labelPreserving": True},
                {"name": "unknown-labels", "frame": changed, "labelPreserving": False}]
def build_pipeline(context):`).replace("return Pipeline([", "return DiagnosticPipeline([");

test("supervised diagnostic fits stay within training folds and preserve primary evidence and invocation IDs", async () => {
    const project = temporaryProject("validation-measurements-");
    writeFileSync(join(project.solutionsRoot, "tasks/fixture.py"), code);
    commitAll(project.solutionsRoot, "Slice, curve and perturbation fixture");
    const training = createHarnessTraining({ root: join(project.root, "training"), projectRoot: project.root,
        solutionsRoot: project.solutionsRoot, pythonExecutable: PYTHON, env: trainingEnvironment(),
        taskId: "fixture", datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13,
        zipPath: project.zipPath, labelsPath: project.labelsPath, workerPath: WORKER,
        pipelineRunId: "validation-packet", stageInvocationId: "validation-invocation",
        prompts: loadPromptSnapshot(), record() {}, limits: { sampleIntervalMs: 25 } });
    try {
        await expect(training.service.start({ schemaVersion: 2, hypothesis: "invalid hook",
            pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
            cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 2 }, scope: { kind: "pilot" },
            diagnostics: { slices: { method: "diagnostic_slices_missing" } } })).rejects.toThrow("diagnostic_slices_missing");
        expect(training.supervisor.list()).toHaveLength(0);
        const started = await training.service.start({ schemaVersion: 2, hypothesis: "measure data sensitivity",
            pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
            cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 2 }, scope: { kind: "promotion" },
            diagnostics: { slices: { method: "diagnostic_slices" }, robustness: { method: "diagnostic_changes" },
                learningCurve: { fractions: [.5, 1] } } });
        expect(await until(() => training.supervisor.status(started.id).status !== "running")).toBe(true);
        await training.service.finalize(started.id);
        const result = JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
        expect(result.status).toBe("completed");
        expect(result.metrics.balancedAccuracy).toBe(1);
        expect(result.promotionEligible).toBe(true);
        const d = result.diagnostics.folds[0].diagnostics;
        expect(d.lowFpr.points[0].recall).toBe(1);
        expect(d.lowFpr.fprResolution).toBeGreaterThan(0);
        expect(d.calibration.binaryPositiveProbabilityEce).toBeGreaterThanOrEqual(0);
        expect(d.slices.groups[1].primaryAvailable).toBe(false);
        expect(d.slices.groups[2].available).toBe(false);
        expect(d.learningCurve.points[0].fitRows).toBe(40);
        expect(d.learningCurve.points[0].validationRows).toBe(40);
        expect(d.learningCurve.points[1].reusedPrimaryFit).toBe(true);
        expect(d.robustness.variants[0].agreement.predictionChangedFraction).toBe(0);
        expect(d.robustness.variants[1].quality.available).toBe(false);
        expect(d.robustness.variants[1].metrics).toBeUndefined();
        expect((await collectTrainingTrial(started.directory)).eligible).toBe(true);
        const events = readFileSync(join(started.directory, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(events.filter(event => event.type === "diagnostic_fit_started")).toHaveLength(6);
        expect(events.every(event => event.pipelineRunId === "validation-packet" && event.stageInvocationId === "validation-invocation")).toBe(true);
        const status = training.service.describe(started.id) as any;
        expect(status.diagnostics.folds[0].diagnostics.learningCurve.points[0].diagnostics.calibration.bins).toBeUndefined();
        expect(status.diagnostics.folds[0].diagnostics.lowFpr.points).toHaveLength(3);
    } finally { await training.close(); }
}, 45000);

test("compact diagnostics summarize nested slices and volume while retaining full artifact data", () => {
    const detail = { volume: { excessMass: Array(51).fill({ t: .1, value: .2 }), excessMassArea: .3 },
        slices: { groups: Array.from({ length: 12 }, (_, i) => ({ name: String(i),
            diagnostics: { geometry: { silhouette: { value: .5, perCluster: { a: {} } } },
                external: { adjustedRandIndex: .8, contingency: [[1]], clusters: [0] } } })) } };
    const result = { diagnostics: { folds: [{ diagnostics: detail }] } };
    const compact = compactDiagnostics(result) as any;
    const shown = compact.folds[0].diagnostics;
    expect(shown.volume.excessMass).toBeUndefined();
    expect(shown.volume.excessMassArea).toBe(.3);
    expect(shown.slices.groups).toHaveLength(8);
    expect(shown.slices.totalGroups).toBe(12);
    expect(shown.slices.groups[0].diagnostics.external.contingency).toBeUndefined();
    expect(shown.slices.groups[0].diagnostics.geometry.silhouette.value).toBe(.5);
    expect(detail.slices.groups).toHaveLength(12);
    expect(detail.volume.excessMass).toHaveLength(51);
});
