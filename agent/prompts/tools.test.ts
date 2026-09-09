import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch from "../tools/web_search.js";
import memory from "../tools/memory.js";
import challengeContext from "../tools/challenge_context.js";
import smartlab from "../tools/smartlab.js";
import { TOOL_PROMPTS } from "./tools.js";

test("extensions register centralized tool descriptions without executing tools", () => {
	const registered: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
	const api = { registerTool: (tool: typeof registered[number]) => registered.push(tool) } as unknown as ExtensionAPI;
	for (const extension of [webSearch, memory, challengeContext, smartlab]) extension(api);
	assert.equal(registered.length, Object.keys(TOOL_PROMPTS).length);
	for (const tool of registered) {
		const expected = TOOL_PROMPTS[tool.name as keyof typeof TOOL_PROMPTS];
		assert.equal(tool.description, expected.description);
		assert.equal(tool.promptSnippet, expected.promptSnippet);
		assert.deepEqual(tool.promptGuidelines, expected.promptGuidelines);
		assert.ok(Object.isFrozen(expected));
	}
});
