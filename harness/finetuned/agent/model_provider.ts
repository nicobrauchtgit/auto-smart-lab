import { MissingModelError } from "../../../experiment/config.js";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { loadPipelineConfig, type PipelineConfig } from "./pipeline_config.ts";

export interface InitializeModelOptions {
	config?: PipelineConfig;
	configPath?: string;
	experimentConfigPath?: string;
	model?: string;
}

export async function initializeModel(options: InitializeModelOptions = {}) {
	const config = options.config ?? (await loadPipelineConfig(options.configPath, options.experimentConfigPath)).config;
	if (!config.defaultModel) throw new MissingModelError();
	if (options.model && options.model !== config.defaultModel) throw new Error("Select the model in experiment.config.json instead of overriding it");
	const modelRef = config.defaultModel;
	const separator = modelRef.indexOf("/");
	if (separator < 1) throw new Error(`Invalid model reference: ${modelRef}`);

	const providerId = modelRef.slice(0, separator);
	const modelId = modelRef.slice(separator + 1);
	const provider = config.providers[providerId];
	if (!provider) throw new Error(`Unknown pipeline provider: ${providerId}`);

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	if ("builtin" in provider && provider.models) {
		modelRuntime.registerProvider(providerId, { models: provider.models.map(m => ({ ...m, name: m.name ?? m.id, reasoning: m.reasoning ?? false, input: m.input ?? ["text"], cost: m.cost ?? {input:0,output:0,cacheRead:0,cacheWrite:0} })) });
	}
	if (!("builtin" in provider)) {
		const apiKey = process.env[provider.apiKeyEnv];
		if (!apiKey) throw new Error(`${provider.apiKeyEnv} must be set`);
		modelRuntime.registerProvider(providerId, {
			name: provider.name ?? providerId,
			baseUrl: provider.baseUrl,
			api: provider.api,
			models: provider.models.map((model) => ({
				...model,
				name: model.name ?? model.id,
				reasoning: model.reasoning ?? false,
				input: model.input ?? ["text"],
				cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		});
		await modelRuntime.setRuntimeApiKey(providerId, apiKey);
	}

	const model = modelRuntime.getModel(providerId, modelId);
	if (!model) throw new Error(`Unknown pipeline model: ${modelRef}`);

	return { modelId: modelRef, modelRuntime, model, ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}) };
}
