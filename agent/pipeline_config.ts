import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Api } from "@earendil-works/pi-ai";

export interface PipelineConfig {
	agent: {
		cwd: string;
		agentDir: string;
		initialPrompt: string;
	};
	defaultModel: string;
	providers: Record<string, {
		name?: string;
		baseUrl: string;
		api: Api;
		apiKeyEnv: string;
		models: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			input?: ("text" | "image")[];
			contextWindow: number;
			maxTokens: number;
		}>;
	}>;
}

export async function loadPipelineConfig(configPath = "pipeline.config.json") {
	const path = resolve(configPath);
	const config = JSON.parse(await readFile(path, "utf8")) as PipelineConfig;
	const configDir = dirname(path);

	return {
		config,
		cwd: resolve(configDir, config.agent.cwd),
		agentDir: resolve(configDir, config.agent.agentDir),
		initialPrompt: config.agent.initialPrompt,
	};
}
