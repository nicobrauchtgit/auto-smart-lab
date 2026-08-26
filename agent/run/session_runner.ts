/**
 * Shared helper: run a pi agent session with a given system prompt and initial user message.
 * Returns the collected assistant text from the completed run.
 *
 * Uses the PI SDK with the project pipeline configuration.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { initializeModel } from "../model_provider.js";
import { loadPipelineConfig } from "../pipeline_config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".."); // agent/run/ → agent/
const TOOLS_DIR = join(AGENT_DIR, "tools");

const EXTENSION_PATHS = [
	join(TOOLS_DIR, "smartlab.ts"),
	join(TOOLS_DIR, "memory.ts"),
	join(TOOLS_DIR, "web_search.ts"),
	join(TOOLS_DIR, "challenge_context.ts"),
];

export interface RunSessionOptions {
	/** Path to the markdown instruction file used as system prompt */
	instructionsPath: string;
	/** Initial user message to send */
	prompt: string;
	/** Optional env vars to inject into process.env for this session */
	env?: Record<string, string>;
	/** Optional provider/model reference from pipeline.config.json */
	model?: string;
}

export interface RunSessionResult {
	/** All assistant text output collected during the run */
	output: string;
}

/**
 * Run a PI agent session, wait for it to settle, and return the collected output.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
	const { instructionsPath, prompt, env, model: requestedModel } = options;

	// Inject env vars before session starts (tools read from process.env)
	const envBackup: Record<string, string | undefined> = {};
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			envBackup[key] = process.env[key];
			process.env[key] = value;
		}
	}

	try {
		const systemPrompt = readFileSync(instructionsPath, "utf8");
		const pipeline = await loadPipelineConfig();
		const { cwd, agentDir } = pipeline;

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: EXTENSION_PATHS,
			systemPrompt,
			// Disable context files (AGENTS.md / CLAUDE.md) to keep prompts clean
			noContextFiles: true,
		});

		await resourceLoader.reload();

		const { modelRuntime, model } = await initializeModel({
			config: pipeline.config,
			model: requestedModel,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
		});

		// Collect all assistant text deltas
		const textParts: string[] = [];

		const settled = new Promise<void>((resolve, reject) => {
			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (event.type === "agent_settled") {
					unsubscribe();
					resolve();
				}
				// Collect text from message updates
				if (event.type === "message_update" && "delta" in event) {
					const delta = (event as { type: string; delta: unknown }).delta;
					if (typeof delta === "string") textParts.push(delta);
					else if (
						delta !== null &&
						typeof delta === "object" &&
						"type" in delta &&
						(delta as { type: string }).type === "text" &&
						"text" in delta
					) {
						textParts.push(String((delta as { text: unknown }).text));
					}
				}
				if (event.type === "agent_end" && "willRetry" in event && !event.willRetry) {
					// session will settle after this
				}
			});

			// Safety timeout: 30 minutes
			setTimeout(() => {
				unsubscribe();
				reject(new Error("Session timed out after 30 minutes"));
			}, 30 * 60 * 1000);
		});

		await session.prompt(prompt);
		await settled;

		// Fallback: if we didn't capture text via events, extract from session messages
		if (textParts.length === 0) {
			const messages = session.messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (
					msg &&
					typeof msg === "object" &&
					"role" in msg &&
					(msg as { role: string }).role === "assistant"
				) {
					const content = (msg as { content: unknown }).content;
					if (typeof content === "string") {
						textParts.push(content);
						break;
					}
					if (Array.isArray(content)) {
						for (const block of content) {
							if (
								block &&
								typeof block === "object" &&
								"type" in block &&
								(block as { type: string }).type === "text" &&
								"text" in block
							) {
								textParts.push(String((block as { text: unknown }).text));
							}
						}
						if (textParts.length > 0) break;
					}
				}
			}
		}

		return { output: textParts.join("") };
	} finally {
		// Restore env vars
		if (env) {
			for (const [key, originalValue] of Object.entries(envBackup)) {
				if (originalValue === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = originalValue;
				}
			}
		}
	}
}
