import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "../tools/web_search.js";
import challengeContext from "../tools/challenge_context.js";
import smartlab from "../tools/smartlab.js";
import { TOOL_PROMPTS } from "./tools.js";
import { loadPromptSnapshot } from "./loader.js";
import { createHarnessTrainingTools } from "../training/tools.js";
import type { TrainingService } from "../training/service.js";
import type { ExperimentSupervisor } from "../experiments/supervisor.js";

test("extensions register centralized tool descriptions without executing tools", () => {
	const registered: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
	const api = { registerTool: (tool: typeof registered[number]) => registered.push(tool) } as unknown as ExtensionAPI;
	for (const extension of [webSearch, challengeContext, smartlab]) extension(api);
	assert.equal(registered.length, Object.keys(TOOL_PROMPTS).length);
	for (const tool of registered) {
		const expected = TOOL_PROMPTS[tool.name as keyof typeof TOOL_PROMPTS];
		assert.equal(tool.description, expected.description);
		assert.equal(tool.promptSnippet, expected.promptSnippet);
		assert.deepEqual(tool.promptGuidelines, expected.promptGuidelines);
		assert.ok(Object.isFrozen(expected));
	}
});

test("smoke and every task-specific trial tool expose the same path, CV and source contract", () => {
	const prompts = loadPromptSnapshot();
	const contract = prompts.render("training.request-contract", {}).text;
	for (const taskKind of [undefined, "classification", "clustering", "anomaly_detection"] as const) {
		const tools = createHarnessTrainingTools({ taskKind } as TrainingService, {} as ExperimentSupervisor, prompts);
		for (const name of ["trial_smoke", "experiment_start"]) {
			const description = tools.find(tool => tool.name === name)!.description;
			assert.ok(description.includes(contract), `${name}/${taskKind} lost the shared request contract`);
			assert.match(description, /pipeline\.module: "tasks\/spam1\.py"/);
			assert.match(description, /scheme:"kfold",folds:3,repeats:1/);
			assert.match(description, /must contain no symlinks/);
		}
	}
});
