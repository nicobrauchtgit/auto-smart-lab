import { expect, test } from "bun:test";
import { validateExperimentRequest } from "./contract.js";

const base = { schemaVersion: 2, hypothesis: "measure geometry", pipeline: { module: "solutions/model.py", factory: "build" },
    cv: { kind: "builtin", scheme: "kfold", folds: 3, repeats: 1 }, scope: { kind: "pilot" } };

test("diagnostic options and explicit proxy direction survive structural validation", () => {
    const request = { ...base, diagnostics: { representation: { source: "pipeline_features", metric: "euclidean", maxRows: 256 }, predictionStrength: true },
        search: { sampler: "grid", objective: { kind: "proxy", metric: "daviesBouldin", direction: "minimize" },
            space: { model__n_clusters: { type: "categorical", choices: [2, 3] } } } };
    expect(validateExperimentRequest(request)).toEqual({ request, issues: [] });
});

test.each([
    { representation: { source: "raw" } },
    { representation: { source: "method", method: "_private" } },
    { representation: { source: "method", method: "features", maxRows: 100000 } },
    { representation: { source: "pipeline_features", seed: 123 } },
    { predictionStrength: "true" },
    { modelSignals: { method: "fit", maxRows: 10000 } },
    { modelSignals: { method: "fit", maxRows: 10 } },
    { volume: { bounds: [[1, 0]], scoreSource: "method", scoreMethod: "scores" } },
    { contamination: { parameter: "model__random_state", values: [.1] } },
])("invalid diagnostics fail structurally without a request: %j", diagnostics => {
    const result = validateExperimentRequest({ ...base, diagnostics });
    expect(result.request).toBeUndefined();
    expect(result.issues.some(issue => issue.path.startsWith("diagnostics"))).toBe(true);
});

test("a proxy search requires an explicit valid direction", () => {
    const result = validateExperimentRequest({ ...base, search: { sampler: "grid", objective: { kind: "proxy", metric: "estimator_score" },
        space: { quality: { type: "categorical", choices: [1, 2] } } } });
    expect(result.request).toBeUndefined();
    expect(result.issues.some(issue => issue.path === "search.objective.direction")).toBe(true);
});
