import { describe, expect, test } from "bun:test";

import { resolvePipelineSettings } from "./config.js";
import { STAGE_REGISTRY } from "./registry.js";
import { spamConfiguration } from "./task_configuration.testing.js";
import type { PipelineConfig } from "../pipeline_config.js";

function config(pipeline: unknown): PipelineConfig {
	return {
		pipeline,
		agent: { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" },
		defaultModel: "saia/test-model",
		providers: {},
	} as PipelineConfig;
}

describe("resolvePipelineSettings", () => {
	test("task configurations come from a validated, fingerprinted pipeline.tasks section", () => {
		const block = (tasks: unknown) => ({ version: 1, entryStage: "solve", stages: { solve: { enabled: true } }, tasks });
		const resolved = resolvePipelineSettings(config(block({ spam1: spamConfiguration() })));
		expect(resolved.taskConfigurations.spam1).toEqual(spamConfiguration());
		expect(resolved.snapshot.tasks).toEqual({ spam1: spamConfiguration() });
		const clustering = { ...spamConfiguration(), kind: "clustering", targets: { kind: "families", file: "f.labels" }, execution: "batch",
			holdout: "group", metric: "adjusted_rand_index", refit: "fit_predict_test_batch", submission: { format: "id_semicolon_prediction", predictions: "cluster_id" } };
		const changed = resolvePipelineSettings(config(block({ spam1: spamConfiguration(), apk: clustering })));
		expect(changed.fingerprint).not.toBe(resolved.fingerprint);
		// An inconsistent entry fails the whole file before any stage can run.
		expect(() => resolvePipelineSettings(config(block({ apk: { ...clustering, metric: "balanced_accuracy" } }))))
			.toThrow("pipeline.tasks.apk: Inconsistent task configuration");
		expect(() => resolvePipelineSettings(config(block({ apk: { ...clustering, samples: { source: "zip_members", train: "../x.zip", test: "t.zip" } } }))))
			.toThrow("samples.train must be a file name");
		expect(() => resolvePipelineSettings(config(block([])))).toThrow("keyed by task ID");
	});

	test("resolves the solve-only pipeline with defaulted options", () => {
		const resolved = resolvePipelineSettings(config({
			version: 1,
			entryStage: "solve",
			scheduling: "configured",
			stages: { solve: { enabled: true, options: {} }, refit: { enabled: false } },
		}));
		expect(resolved.enabledStages).toEqual(["solve"]);
		expect(resolved.effectiveOptions.solve).toMatchObject({ seed: 13 });
		expect(resolved.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("configuration cannot enable an unregistered known stage, and registered submission is available", () => {
        const submit = STAGE_REGISTRY.submit;
        try {
            delete STAGE_REGISTRY.submit;
            expect(() => resolvePipelineSettings(config({ entryStage: "solve", stages: { solve: { enabled: true }, submit: { enabled: true } } }))).toThrow(/not implemented/);
        } finally { STAGE_REGISTRY.submit = submit; }
        expect(resolvePipelineSettings(config({ entryStage: "solve", stages: { solve: { enabled: true }, submit: { enabled: true } } })).enabledStages).toContain("submit");
    });

	test("rejects unknown stages and unknown stage options", () => {
		expect(() => resolvePipelineSettings(config({
			entryStage: "solve",
			stages: { solve: { enabled: true }, deploy: { enabled: false } },
		}))).toThrow(/Unknown pipeline stage/);
		expect(() => resolvePipelineSettings(config({
			entryStage: "solve",
			stages: { solve: { enabled: true, options: { injectStartup: true } } },
		}))).toThrow(/unknown solve options/);
	});

	test("rejects a disabled entry stage and unsupported versions", () => {
		expect(() => resolvePipelineSettings(config({
			entryStage: "solve",
			stages: { solve: { enabled: false } },
		}))).toThrow(/not enabled/);
		expect(() => resolvePipelineSettings(config({ version: 2, stages: {} }))).toThrow(/Unsupported pipeline config version/);
	});

	test("falls back to the solve-only default with a warning", () => {
		const resolved = resolvePipelineSettings(config(undefined));
		expect(resolved.enabledStages).toEqual(["solve"]);
		expect(resolved.warnings).toHaveLength(1);
	});
});
