import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Api } from "@earendil-works/pi-ai";
import { EXPERIMENT_CONFIG_PATH, loadExperimentConfig, modelReference, type ModelCompat } from "../../../experiment/config.js";
import { ARM_ROOT } from "./paths.js";

export type PipelineProviderConfig =
	| { builtin: true; apiKeyEnv?: string }
	| {
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
			/** pi's request settings for OpenAI-compatible servers, e.g. no developer role. */
			compat?: ModelCompat;
		}>;
	};

/** This arm's file (stages, tasks, agent) joined with the repository's shared settings. */
export interface PipelineConfig {
	/** Stage availability and options. Validated by agent/pipeline/config.ts. */
	pipeline?: {
		version?: number;
		entryStage?: string;
		scheduling?: string;
		stages?: Record<string, { enabled?: boolean; options?: unknown }>;
		/** Task configuration per task ID. Validated by agent/pipeline/task_configuration.ts. */
		tasks?: Record<string, unknown>;
	};
	agent: {
		cwd: string;
		agentDir: string;
		initialPrompt: string;
	};
	/** From experiment.config.json: `provider/model`. */
	defaultModel: string;
	/** From experiment.config.json. */
	providers: Record<string, PipelineProviderConfig>;
	/** From experiment.config.json. */
	online?: boolean;
}

/** Settings that belong to experiment.config.json; the arm's file must not repeat them. */
const SHARED_KEYS = ["defaultModel", "providers", "model", "online"];

export async function loadPipelineConfig(configPath = join(ARM_ROOT, "pipeline.config.json"), experimentConfigPath = EXPERIMENT_CONFIG_PATH) {
	const path = resolve(configPath);
	const arm = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	const repeated = SHARED_KEYS.filter(key => key in arm);
	if (repeated.length) throw new Error(`${path} sets ${repeated.join(", ")}; these belong in ${experimentConfigPath} only`);
	const shared = loadExperimentConfig(experimentConfigPath);
	const config = { ...arm, defaultModel: modelReference(shared), providers: shared.providers, online: shared.online } as PipelineConfig;
	const configDir = dirname(path);

	return {
		config,
		cwd: resolve(configDir, config.agent.cwd),
		agentDir: resolve(configDir, config.agent.agentDir),
		initialPrompt: config.agent.initialPrompt,
	};
}
