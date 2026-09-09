import { describe, expect, test } from "bun:test";

import { resolvePipelineSettings } from "./config.js";
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
	test("resolves the research-only pipeline with defaulted options", () => {
		const resolved = resolvePipelineSettings(config({
			version: 1,
			entryStage: "research",
			scheduling: "configured",
			stages: { research: { enabled: true, options: {} }, solve: { enabled: false } },
		}));
		expect(resolved.enabledStages).toEqual(["research"]);
		expect(resolved.effectiveOptions.research).toEqual({ injectStartupContext: true });
		expect(resolved.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test("configuration cannot enable an unimplemented stage", () => {
		expect(() => resolvePipelineSettings(config({
			entryStage: "research",
			stages: { research: { enabled: true }, solve: { enabled: true } },
		}))).toThrow(/not implemented/);
	});

	test("rejects unknown stages and unknown stage options", () => {
		expect(() => resolvePipelineSettings(config({
			entryStage: "research",
			stages: { research: { enabled: true }, deploy: { enabled: false } },
		}))).toThrow(/Unknown pipeline stage/);
		expect(() => resolvePipelineSettings(config({
			entryStage: "research",
			stages: { research: { enabled: true, options: { injectStartup: true } } },
		}))).toThrow(/unknown research options/);
	});

	test("rejects a disabled entry stage and unsupported versions", () => {
		expect(() => resolvePipelineSettings(config({
			entryStage: "research",
			stages: { research: { enabled: false } },
		}))).toThrow(/not enabled/);
		expect(() => resolvePipelineSettings(config({ version: 2, stages: {} }))).toThrow(/Unsupported pipeline config version/);
	});

	test("falls back to the research-only default with a warning", () => {
		const resolved = resolvePipelineSettings(config(undefined));
		expect(resolved.enabledStages).toEqual(["research"]);
		expect(resolved.warnings).toHaveLength(1);
	});
});
