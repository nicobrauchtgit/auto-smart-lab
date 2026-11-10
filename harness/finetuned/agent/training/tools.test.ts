import { expect, test } from "bun:test";

import { loadPromptSnapshot } from "../prompts/loader.js";
import { createHarnessTrainingTools } from "./tools.js";

test("experiment_start declares its nested request fields as JSON objects", () => {
	// With untyped schemas, MythLLM's Qwen sent cv/scope as JSON strings, and every request was rejected.
	const tools = createHarnessTrainingTools({} as any, {} as any, loadPromptSnapshot());
	const start = tools.find(tool => tool.name === "experiment_start")!;
	const properties = (start.parameters as any).properties;
	for (const key of ["cv", "scope"]) expect(properties[key].type).toBe("object");
	expect(properties.search.properties.space.type).toBe("object");
	const pipeline = properties.pipeline.allOf.find((part: any) => part.properties?.parameters);
	expect(pipeline.properties.parameters.type).toBe("object");
	expect(pipeline.properties.estimatorParams.type).toBe("object");
});
