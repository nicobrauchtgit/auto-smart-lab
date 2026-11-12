import { expect, test } from "bun:test";
import { HARNESS_CONFIG, HARNESS_CONFIG_SHA256, parseHarnessConfig } from "./config.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { leadStage } from "../pipeline/stages/lead.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import type { PipelineConfig } from "../pipeline_config.js";
import { DEFAULT_LIMITS as supervisor } from "../experiments/types.js";
import { DEFAULT_LIMITS as children } from "../subagents/types.js";
import { SESSION_MAX_WALL_MS } from "../run/session_runner.js";
import { CONTEXT_HANDOFF_TOKENS } from "../context/session.js";

function resolve(seed: number) {
	const previous = STAGE_REGISTRY.lead;
	STAGE_REGISTRY.lead = leadStage;
	try { return resolvePipelineSettings({ defaultModel: "test/model", providers: {},
		agent: { cwd: ".", agentDir: ".pi", initialPrompt: "" },
		pipeline: { version: 1, entryStage: "lead", scheduling: "configured", stages: {
			lead: { enabled: true, options: { seed } },
		} },
	} as PipelineConfig); } finally {
		if (previous) STAGE_REGISTRY.lead = previous;
		else delete STAGE_REGISTRY.lead;
	}
}

test("consumers use the immutable central defaults", () => {
	expect(supervisor).toBe(HARNESS_CONFIG.supervision);
	expect(children).toBe(HARNESS_CONFIG.subagents.limits);
	expect(SESSION_MAX_WALL_MS).toBe(HARNESS_CONFIG.session.maxWallMs);
	expect(CONTEXT_HANDOFF_TOKENS).toBe(HARNESS_CONFIG.context.handoffTokens);
	expect(Object.isFrozen(HARNESS_CONFIG.foldRecommendations[0])).toBe(true);
});

test("each run snapshot includes central settings and effective stage overrides", () => {
	const first = resolve(6), second = resolve(3);
	expect(first.snapshot.harness).toEqual(HARNESS_CONFIG);
	expect(first.snapshot.harness_sha256).toBe(HARNESS_CONFIG_SHA256);
	expect((second.effectiveOptions.lead as any).seed).toBe(3);
	expect(first.fingerprint).not.toBe(second.fingerprint);
	expect(resolve(6).fingerprint).toBe(first.fingerprint);
});

test("invalid tuning values fail before starting sessions", () => {
	for (const mutate of [
		(value: any) => { value.context.handoffTokens = 0; },
		(value: any) => { value.supervision.sampleIntervalMs = -1; },
		(value: any) => { value.session.maxWallMs = 3_000_000_000; },
		(value: any) => { value.holdout.maxFraction = 0.7; },
		(value: any) => { value.subagents.waitTimeoutMs = value.subagents.maxWaitTimeoutMs + 1; },
		(value: any) => { value.foldRecommendations[1].belowRows = 1; },
		(value: any) => { value.solve.typo = 30; },
	]) {
		const input = structuredClone(HARNESS_CONFIG); mutate(input);
		expect(() => parseHarnessConfig(input)).toThrow();
	}
	const input = structuredClone(HARNESS_CONFIG);
	input.solve.foldPolicy = { folds: 3, repeats: 2 };
	expect(parseHarnessConfig(input).solve.foldPolicy).toEqual({ folds: 3, repeats: 2 });
});
