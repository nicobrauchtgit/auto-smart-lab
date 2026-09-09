import { createHash } from "node:crypto";
import definitions from "./tools.json";

// Extensions retain one immutable set of tool instructions for this process.
// Restart the pipeline process to adopt edits to tools.json.
for (const [name, definition] of Object.entries(definitions)) {
	if (typeof definition.description !== "string" || typeof definition.promptSnippet !== "string"
		|| !Array.isArray(definition.promptGuidelines)
		|| !definition.promptGuidelines.every(value => typeof value === "string")
		|| !Object.values(definition.parameters).every(value => typeof value === "string")) {
		throw new Error(`Invalid tool prompt definition: ${name}`);
	}
	Object.freeze(definition.promptGuidelines);
	Object.freeze(definition.parameters);
	Object.freeze(definition);
}

export const TOOL_PROMPTS = Object.freeze(definitions);
export const TOOL_PROMPTS_SHA256 = createHash("sha256").update(JSON.stringify(TOOL_PROMPTS)).digest("hex");
