/**
 * Shared helper: run a pi agent session with a given system prompt and initial user message.
 * Returns the collected assistant text from the completed run.
 *
 * Uses the PI SDK with the project pipeline configuration.
 */

import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { initializeModel } from "../model_provider.js";
import { observeAgentSession, type AgentObservation } from "../observability.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPipelineResourceLoader } from "./session_resources.js";
import type { PromptReference, PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { TOOL_PROMPTS_SHA256 } from "../prompts/tools.js";
import { preparePythonEnvironment, pythonChangeCursor, recordPythonEnvironmentEnd, readPythonEnvironment } from "./python_environment.js";
import type { SuppliedInput } from "../pipeline/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".."); // agent/run/ → agent/
const TOOLS_DIR = join(AGENT_DIR, "tools");

const EXTENSION_PATHS = [
	join(TOOLS_DIR, "smartlab.ts"),
	join(TOOLS_DIR, "memory.ts"),
	join(TOOLS_DIR, "web_search.ts"),
	join(TOOLS_DIR, "challenge_context.ts"),
];

/** How long one agent session may run. The cost signal is measured against it. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunSessionOptions {
	prompts: PromptSnapshot;
	reportInput?: (input: SuppliedInput) => void;
	/** Rendered from the run's immutable prompt snapshot. */
	system: RenderedPrompt;
	promptReferences: PromptReference[];
	/** Initial user message to send */
	prompt: string;
	/** Optional env vars to inject into process.env for this session */
	env?: Record<string, string>;
	/** Optional provider/model reference from pipeline.config.json */
	model?: string;
	/** Built-in tools exposed to the session. Omit for the normal solver/eval set. */
	tools?: string[];
	/** Whether project extensions should be loaded. Defaults to true. */
	extensions?: boolean;
	/** Optional extension allowlist. Defaults to the normal pipeline extensions. */
	extensionPaths?: string[];
	/** Optional working directory override for a scoped module session. */
	cwd?: string;
	/**
	 * Attach the shared observer to this session. Supplied by the pipeline executor
	 * so prompts, messages, tool calls, usage, and errors land under the enclosing
	 * stage invocation.
	 */
	observe?: AgentObservation;
	/** Abort the running session. The session is stopped and the error is recorded. */
	signal?: AbortSignal;
}

export interface RunSessionResult {
	/** All assistant text output collected during the run */
	output: string;
	/** Identity of the observed agent run, when observation was attached. */
	agentRunId?: string;
}

/**
 * Run a PI agent session, wait for it to settle, and return the collected output.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
	const { prompt, model: requestedModel } = options;
	const changeCursor = pythonChangeCursor();
	const pythonSessionId = randomUUID();
	const initialEnvironment = readPythonEnvironment();
	const python = preparePythonEnvironment(options.prompts, initialEnvironment);
	options.reportInput?.(python.input);
	const identity = options.observe?.identity;
	const env = {
		...options.env, ...python.env,
		PIPELINE_PYTHON_SESSION_ID: pythonSessionId,
		...(identity?.pipelineRunId ? { PIPELINE_RUN_ID: identity.pipelineRunId } : {}),
		...(identity?.stageInvocationId ? { PIPELINE_STAGE_INVOCATION_ID: identity.stageInvocationId } : {}),
		...(identity?.attempt !== undefined && identity.attempt !== null ? { PIPELINE_AGENT_ATTEMPT: String(identity.attempt) } : {}),
	};

	// Inject env vars before session starts (tools read from process.env)
	const envBackup: Record<string, string | undefined> = {};
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			envBackup[key] = process.env[key];
			process.env[key] = value;
		}
	}

	try {
		const systemPrompt = [options.system.text, python.prompt.text].join("\n\n");
		const pipeline = await loadPipelineConfig();
		const { cwd, agentDir } = pipeline;
		const sessionCwd = options.cwd ? resolve(options.cwd) : cwd;
		const extensionPaths = options.extensionPaths ?? EXTENSION_PATHS;

		const resourceLoader = createPipelineResourceLoader({
			cwd: sessionCwd,
			agentDir,
			additionalExtensionPaths: options.extensions === false ? [] : extensionPaths,
			noExtensions: options.extensions === false,
			systemPrompt,
		});

		await resourceLoader.reload();

		const { modelId, modelRuntime, model } = await initializeModel({
			config: pipeline.config,
			model: requestedModel,
		});
		const { session } = await createAgentSession({
			cwd: sessionCwd,
			agentDir,
			modelRuntime,
			model,
			...(options.tools ? { tools: options.tools } : {}),
			resourceLoader,
			sessionManager: SessionManager.inMemory(sessionCwd),
		});

		// Attach the shared observer before the first prompt so nothing is missed.
		const observability = options.observe
			? await observeAgentSession({
				session,
				model: modelId,
				identity: options.observe.identity,
				sink: options.observe.sink,
			})
			: undefined;

		try {
			observability?.record("prompt_snapshot", {
				type: "prompt_snapshot",
				prompts: [...options.promptReferences, python.prompt.reference],
				system_prompt: systemPrompt,
				initial_prompt: prompt,
				tool_prompts_sha256: TOOL_PROMPTS_SHA256,
				effective_system_prompt: session.systemPrompt,
				effective_system_prompt_sha256: createHash("sha256").update(session.systemPrompt).digest("hex"),
				system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex"),
				initial_prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
			});
			observability?.record("runtime_input", { type: "runtime_input", input: python.input });
			// Collect assistant text deltas for callers that want streamed output.
			const textParts: string[] = [];
			const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
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
			});

			let timeout: ReturnType<typeof setTimeout> | undefined;
			let stopped = false;
			let onAbort: (() => void) | undefined;
			try {
				await Promise.race([
					session.prompt(prompt),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => {
							stopped = true;
							reject(new Error(`Session timed out after ${SESSION_TIMEOUT_MS / 60000} minutes`));
						}, SESSION_TIMEOUT_MS);
					}),
					// The session keeps calling the model until it is aborted, so
					// cancellation has to reach it rather than only the caller.
					new Promise<never>((_, reject) => {
						if (!options.signal) return;
						onAbort = () => {
							stopped = true;
							reject(new Error("Session cancelled"));
						};
						options.signal.addEventListener("abort", onAbort, { once: true });
						if (options.signal.aborted) onAbort();
					}),
				]);
			} catch (error) {
				if (stopped) await session.abort();
				observability?.recordError(error);
				throw error;
			} finally {
				if (timeout) clearTimeout(timeout);
				if (onAbort) options.signal?.removeEventListener("abort", onAbort);
				unsubscribe();
			}
			const lastAssistant = [...session.messages].reverse().find((message) =>
				message && typeof message === "object" && "role" in message && message.role === "assistant"
			) as { stopReason?: string; errorMessage?: string } | undefined;
			if (lastAssistant?.stopReason === "error") {
				const failure = new Error(`Model session failed: ${lastAssistant.errorMessage ?? "unknown model error"}`);
				observability?.recordError(failure);
				throw failure;
			}

			// Fallback: if we didn't capture text via events, extract from session messages
			if (textParts.length === 0) {
				const lastText = session.getLastAssistantText();
				if (lastText) textParts.push(lastText);
			}
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

			return { output: textParts.join(""), ...(observability ? { agentRunId: observability.agentRunId } : {}) };
		} finally {
			// Release the observer and the session on completion, error, and cancellation.
			if (observability) {
				recordPythonEnvironmentEnd({
					initial: initialEnvironment, cursor: changeCursor, sessionId: pythonSessionId,
					record: observability.record,
				});
			}
			await observability?.close();
			session.dispose();
		}
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
