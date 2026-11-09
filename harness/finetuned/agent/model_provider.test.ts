import { describe, expect, test } from "bun:test";

import { initializeModel } from "./model_provider.js";
import type { PipelineConfig } from "./pipeline_config.js";

const agent = { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" };

describe("initializeModel", () => {
	test("uses a native provider without requiring a static API key", async () => {
		const config: PipelineConfig = {
			agent,
			defaultModel: "google-vertex/gemini-3.5-flash",
			providers: { "google-vertex": { builtin: true } },
		};
		const result = await initializeModel({ config });
		expect(result.modelId).toBe("google-vertex/gemini-3.5-flash");
		expect(result.model.api).toBe("google-vertex");
		expect(result.model.contextWindow).toBe(1_048_576);
	});

	test("keeps requiring the configured key for a custom provider", async () => {
		const variable = "SMARTLAB_MISSING_PROVIDER_KEY";
		const previous = process.env[variable];
		delete process.env[variable];
		const config: PipelineConfig = {
			agent,
			defaultModel: "custom/test",
			providers: {
				custom: {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: variable,
					models: [{ id: "test", contextWindow: 1024, maxTokens: 128 }],
				},
			},
		};
		try {
			await expect(initializeModel({ config })).rejects.toThrow(`${variable} must be set`);
		} finally {
			if (previous === undefined) delete process.env[variable];
			else process.env[variable] = previous;
		}
	});
});
