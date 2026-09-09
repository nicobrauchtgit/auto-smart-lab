/**
 * Pipeline configuration: which stages exist, which are enabled, and with what
 * options. Availability and automatic execution are separate concerns — enabling a
 * stage makes it invocable; scheduling decides whether a run reaches it.
 *
 * The resolved configuration is snapshotted and fingerprinted for every run so a
 * trace records the settings the run actually used.
 */

import { createHash } from "node:crypto";

import { loadPipelineConfig, type PipelineConfig } from "../pipeline_config.js";
import { getStage, isImplemented, KNOWN_STAGES } from "./registry.js";
import type { StageName } from "./types.js";

export interface StageSettings {
	enabled: boolean;
	options: unknown;
}

export interface PipelineSettings {
	version: 1;
	entryStage: StageName;
	scheduling: "configured";
	stages: Record<string, StageSettings>;
}

export interface ResolvedPipelineConfig {
	settings: PipelineSettings;
	/** Parsed, defaulted options per enabled and implemented stage. */
	effectiveOptions: Partial<Record<StageName, unknown>>;
	enabledStages: StageName[];
	snapshot: Record<string, unknown>;
	fingerprint: string;
	warnings: string[];
}

const DEFAULT_SETTINGS: PipelineSettings = {
	version: 1,
	entryStage: "research",
	scheduling: "configured",
	stages: { research: { enabled: true, options: {} } },
};

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

export function resolvePipelineSettings(config: PipelineConfig): ResolvedPipelineConfig {
	const warnings: string[] = [];
	const raw = (config as PipelineConfig & { pipeline?: unknown }).pipeline;
	if (raw === undefined) {
		warnings.push("pipeline.config.json has no `pipeline` block; using the research-only default");
	} else if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("`pipeline` must be an object in pipeline.config.json");
	}
	const block = (raw ?? DEFAULT_SETTINGS) as Partial<PipelineSettings>;

	if (block.version !== undefined && block.version !== 1) {
		throw new Error(`Unsupported pipeline config version: ${String(block.version)}`);
	}
	const scheduling = block.scheduling ?? "configured";
	if (scheduling !== "configured") {
		throw new Error(`Unsupported pipeline scheduling mode: ${String(scheduling)}`);
	}

	const rawStages = block.stages ?? DEFAULT_SETTINGS.stages;
	if (typeof rawStages !== "object" || rawStages === null || Array.isArray(rawStages)) {
		throw new Error("`pipeline.stages` must be an object");
	}

	const stages: Record<string, StageSettings> = {};
	const effectiveOptions: Partial<Record<StageName, unknown>> = {};
	const enabledStages: StageName[] = [];

	for (const [name, value] of Object.entries(rawStages)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`pipeline.stages.${name} must be an object`);
		}
		const settings = value as Partial<StageSettings>;
		const enabled = settings.enabled ?? false;
		if (typeof enabled !== "boolean") throw new Error(`pipeline.stages.${name}.enabled must be a boolean`);
		if (!KNOWN_STAGES.includes(name as StageName)) {
			throw new Error(`Unknown pipeline stage "${name}"; known stages: ${KNOWN_STAGES.join(", ")}`);
		}
		if (enabled && !isImplemented(name)) {
			throw new Error(`Stage "${name}" is enabled but not implemented; see docs/pipeline-integration.md`);
		}
		stages[name] = { enabled, options: settings.options ?? {} };
		if (!enabled) continue;
		enabledStages.push(name as StageName);
		// Options are validated at load time, not on first use.
		effectiveOptions[name as StageName] = getStage(name as StageName).parseOptions(settings.options);
	}

	const entryStage = (block.entryStage ?? DEFAULT_SETTINGS.entryStage) as StageName;
	if (!stages[entryStage]?.enabled) {
		throw new Error(`Entry stage "${entryStage}" is not enabled in pipeline.config.json`);
	}

	const settings: PipelineSettings = { version: 1, entryStage, scheduling, stages };
	// The snapshot carries settings and model identity only; no credentials.
	const snapshot = canonical({
		pipeline: settings,
		effectiveOptions,
		defaultModel: config.defaultModel,
		stageVersions: Object.fromEntries(enabledStages.map((name) => [name, getStage(name).version])),
	}) as Record<string, unknown>;

	return {
		settings,
		effectiveOptions,
		enabledStages,
		snapshot,
		fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
		warnings,
	};
}

export async function loadResolvedPipelineConfig(configPath?: string) {
	const loaded = await loadPipelineConfig(configPath);
	return { ...loaded, resolved: resolvePipelineSettings(loaded.config) };
}
