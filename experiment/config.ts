/**
 * The settings both arms share, from `experiment.config.json` at the repository root:
 * whether the experiment runs online, which provider and model it uses, and every
 * provider's definition including the name of its API key variable. The keys themselves
 * stay in `.env`. Neither arm's own configuration repeats these values.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIMENT_CONFIG_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "experiment.config.json");

export interface ModelCompat {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	thinkingFormat?: "chat-template";
	chatTemplateKwargs?: Record<string, string | boolean>;
}

export interface ProviderModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	/** pi's request settings for OpenAI-compatible servers, e.g. no developer role. */
	compat?: ModelCompat;
}

export type ProviderConfig =
	| { builtin: true; apiKeyEnv?: string }
	| { name?: string; baseUrl: string; api: string; apiKeyEnv: string; models: ProviderModel[] };

export interface ExperimentConfig {
	/** Fetch and submit tasks on the lab, with score feedback. Off: shared-drive tasks, hand-over files only. */
	online: boolean;
	/** The provider and model both arms use. */
	model: { provider: string; id: string };
	providers: Record<string, ProviderConfig>;
}

/** `provider/model`, the form pi and both arms' code use. */
export function modelReference(config: Pick<ExperimentConfig, "model">): string {
	return `${config.model.provider}/${config.model.id}`;
}

/** Every problem with a parsed configuration, so one run reports them all. */
export function experimentConfigProblems(value: unknown): string[] {
	const problems: string[] = [];
	const config = value as Partial<ExperimentConfig> | null;
	if (!config || typeof config !== "object") return ["must be a JSON object"];
	const known = new Set(["online", "model", "providers"]);
	for (const key of Object.keys(config)) if (!known.has(key)) problems.push(`unknown key "${key}"`);
	if (typeof config.online !== "boolean") problems.push(`"online" must be true or false`);
	const providers = config.providers;
	if (!providers || typeof providers !== "object") problems.push(`"providers" must name at least one provider`);
	else for (const [id, provider] of Object.entries(providers)) {
		if (id.includes("/")) problems.push(`provider "${id}": the name must not contain "/"`);
		if ("builtin" in provider) {
			if (provider.builtin !== true) problems.push(`provider "${id}": "builtin" can only be true`);
			continue;
		}
		if (typeof provider.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)) problems.push(`provider "${id}": "apiKeyEnv" must name the environment variable holding its key`);
		if (typeof provider.baseUrl !== "string" || !provider.baseUrl) problems.push(`provider "${id}": "baseUrl" is missing`);
		if (typeof provider.api !== "string" || !provider.api) problems.push(`provider "${id}": "api" is missing`);
		if (!Array.isArray(provider.models) || !provider.models.length) problems.push(`provider "${id}": "models" must list at least one model`);
	}
	const model = config.model;
	if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
		problems.push(`"model" must be { "provider": "<name in providers>", "id": "<model id>" }`);
	} else {
		const keys = Object.keys(model).filter(key => key !== "provider" && key !== "id");
		if (keys.length) problems.push(`"model" takes only "provider" and "id", not ${keys.map(key => `"${key}"`).join(", ")}`);
		const provider = providers?.[model.provider];
		if (providers && !provider) problems.push(`"model.provider" is "${model.provider}", which is not in "providers"`);
		else if (provider && !("builtin" in provider) && Array.isArray(provider.models) && !provider.models.some(entry => entry.id === model.id)) {
			problems.push(`"model.id" is "${model.id}", which provider "${model.provider}" does not list`);
		}
	}
	return problems;
}

export function loadExperimentConfig(path = EXPERIMENT_CONFIG_PATH): ExperimentConfig {
	let parsed: unknown;
	try { parsed = JSON.parse(readFileSync(path, "utf8")); }
	catch (error) { throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`); }
	const problems = experimentConfigProblems(parsed);
	if (problems.length) throw new Error(`${path} is invalid:\n${problems.map(problem => `- ${problem}`).join("\n")}`);
	return parsed as ExperimentConfig;
}
