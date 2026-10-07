import type { InvocationFeedback } from "../pipeline/feedback.js";
/**
 * Shared helper: run a pi agent session with a given system prompt and initial user message.
 * Returns the collected assistant text from the completed run.
 *
 * Uses the PI SDK with the project pipeline configuration.
 */

import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initializeModel } from "../model_provider.js";
import { observeAgentSession, type AgentObservation } from "../observability.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPipelineResourceLoader } from "./session_resources.js";
import type { PromptReference, PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { TOOL_PROMPTS_SHA256 } from "../prompts/tools.js";
import { preparePythonEnvironment, pythonChangeCursor, recordPythonEnvironmentEnd, readPythonEnvironment } from "./python_environment.js";
import { SmartContextSession } from "../context/session.js";
import type { Wakeable } from "../experiments/index.js";
import type { SuppliedInput } from "../pipeline/types.js";
import { TaskKnowledge, createKnowledgeTools, selectedKnowledge, knowledgeInput, type KnowledgeOptions } from "../knowledge/service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".."); // agent/run/ → agent/
const TOOLS_DIR = join(AGENT_DIR, "tools");

const EXTENSION_PATHS = [
	join(TOOLS_DIR, "smartlab.ts"),
	join(TOOLS_DIR, "web_search.ts"),
	join(TOOLS_DIR, "challenge_context.ts"),
];

/** How long one agent session may run. The cost signal is measured against it. */
export const SESSION_TIMEOUT_MS = HARNESS_CONFIG.session.timeoutMs;

export interface RunSessionOptions {
	/** Fresh controller state queued at every physical session construction. */
	sessionContext?: () => string;
	/** Explicit task/dataset scope. No ambient/global skill loading. */
	knowledge?: KnowledgeOptions;
	prompts: PromptSnapshot;
 feedback?: InvocationFeedback;
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
	/** Scoped tools supplied by the caller, such as harness-owned experiment controls. */
	customTools?: ToolDefinition[];
	/** Bind services after observation, including every replacement. Use identity to rebind subagent parents. */
	onSessionReady?: (session: Wakeable, identity: { agentRunId?: string; piSessionId: string }) => void | Promise<void>;
	/** Whether project extensions should be loaded. Defaults to true. */
	extensions?: boolean;
	/** Optional extension allowlist. Defaults to the normal pipeline extensions. */
	extensionPaths?: string[];
	/**
	 * In-process extensions such as tool-call guards. Loaded even when file
	 * extensions are disabled, because they are part of the caller's contract.
	 */
	extensionFactories?: InlineExtension[];
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
	/** Final task response; internal context handoffs are never exposed as the result. */
	output: string;
	/** Identity of the observed agent run, when observation was attached. */
	agentRunId?: string;
}

/** Pi's `tools` option allowlists custom definitions as well as built-ins. */
export function sessionToolAllowlist(
	tools: readonly string[] | undefined,
	customTools: readonly Pick<ToolDefinition, "name">[] | undefined,
): string[] | undefined {
	if (tools === undefined) return undefined;
	return [...new Set([...tools, ...(customTools ?? []).map((tool) => tool.name)])];
}

/**
 * Run a PI agent session, wait for it to settle, and return the collected output.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
	const { prompt, model: requestedModel } = options;
	const skills = options.knowledge ? selectedKnowledge(options.prompts) : [];
	let recordKnowledge: ((type: string, payload: Record<string, unknown>) => void) | undefined;
	const knowledge = options.knowledge ? new TaskKnowledge({ ...options.knowledge,
		record: (type, payload) => { options.knowledge?.record?.(type, payload); recordKnowledge?.(type, payload); },
		reportInput: options.reportInput ?? options.knowledge.reportInput,
	}) : undefined;
	knowledge?.store.preflight();
	const customTools = [...(options.customTools ?? []), ...(knowledge ? createKnowledgeTools(knowledge, options.prompts) : [])];
	if (knowledge) options.reportInput?.(knowledgeInput(knowledge.options));
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
		const systemPrompt = [options.system.text, python.prompt.text, ...skills.map(skill => skill.text)].join("\n\n");
		const pipeline = await loadPipelineConfig();
		const { cwd, agentDir } = pipeline;
		const sessionCwd = options.cwd ? resolve(options.cwd) : cwd;
		const extensionPaths = options.extensionPaths ?? EXTENSION_PATHS;

		const resourceLoader = createPipelineResourceLoader({
			cwd: sessionCwd,
			agentDir,
			additionalExtensionPaths: options.extensions === false ? [] : extensionPaths,
			noExtensions: options.extensions === false,
			extensionFactories: [...(options.extensionFactories ?? []), ...(options.observe?.executionGuard ? [{ name: "controller-budget", factory(pi: any) { pi.on("tool_call", () => { try { options.observe!.executionGuard!.beforeToolCall(); } catch { return { block: true, reason: "Controller tool budget exhausted" }; } }); } }] : [])],
			systemPrompt,
		});

		await resourceLoader.reload();

		const { modelId, modelRuntime, model } = await initializeModel({
			config: pipeline.config,
			model: requestedModel,
		});
		const logical: SmartContextSession = new SmartContextSession({
			prompts: options.prompts,
			create: async (opening) => {
				options.observe?.executionGuard?.beforeSession();
				const { session } = await createAgentSession({
					cwd: sessionCwd, agentDir, modelRuntime, model,
					...(options.tools ? { tools: sessionToolAllowlist(options.tools, customTools) } : {}),
					...(customTools.length ? { customTools } : {}),
					resourceLoader, sessionManager: SessionManager.inMemory(sessionCwd),
				});
				const previousPayload = session.agent.onPayload;
				session.agent.onPayload = async (payload, selectedModel) => {
					options.observe?.executionGuard?.beforeModelRequest();
					return await previousPayload?.(payload, selectedModel) ?? payload;
				};
				let observability: Awaited<ReturnType<typeof observeAgentSession>> | undefined;
				try {
					observability = options.observe ? await observeAgentSession({
						session, model: modelId, identity: options.observe.identity, sink: options.observe.sink,
					}) : undefined;
					recordKnowledge = observability?.record;
					knowledge?.bindAgent(observability?.agentRunId);
					if (knowledge) observability?.record("runtime_input", { type: "runtime_input", input: knowledgeInput(knowledge.options) });
					observability?.record("skill_snapshot", { skills: skills.map(skill => skill.reference),
						tool_prompts: knowledge ? [options.prompts.render("knowledge.tool", {}).reference] : [] });
					observability?.record("prompt_snapshot", {
						type: "prompt_snapshot",
						prompts: [...options.promptReferences, python.prompt.reference, opening.reference, ...skills.map(skill => skill.reference)],
						system_prompt: systemPrompt, initial_prompt: opening.text,
						tool_prompts_sha256: TOOL_PROMPTS_SHA256,
						effective_system_prompt: session.systemPrompt,
						effective_system_prompt_sha256: createHash("sha256").update(session.systemPrompt).digest("hex"),
						system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex"),
						initial_prompt_sha256: createHash("sha256").update(opening.text).digest("hex"),
					});
					observability?.record("runtime_input", { type: "runtime_input", input: python.input });
					observability?.record("harness_configuration", { version: 1, settings: HARNESS_CONFIG,
						model: { id: modelId, contextWindow: model.contextWindow, maxTokens: model.maxTokens } });
					await options.onSessionReady?.(logical, { agentRunId: observability?.agentRunId, piSessionId: session.sessionId });
					if (options.sessionContext) await logical.steer(options.sessionContext());
				} catch (error) {
					try { await observability?.close(); } finally { session.dispose(); }
					throw error;
				}
				return {
					session, agentRunId: observability?.agentRunId,
					record: (type, payload) => observability?.record(type, payload),
					async close() {
						try {
							if (observability) recordPythonEnvironmentEnd({ initial: initialEnvironment,
								cursor: changeCursor, sessionId: pythonSessionId, record: observability.record });
							await observability?.close();
						} finally { session.dispose(); }
					},
				};
			},
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			options.signal?.throwIfAborted();
			const response = logical.prompt(options.prompts.render("context.task", { task: prompt }));
            await options.feedback?.bind(logical);
			const output = await Promise.race([
				response,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error(`Session timed out after ${SESSION_TIMEOUT_MS / 60000} minutes`)), SESSION_TIMEOUT_MS);
				}),
				new Promise<never>((_, reject) => {
					onAbort = () => reject(new Error("Session cancelled"));
					options.signal?.addEventListener("abort", onAbort, { once: true });
					if (options.signal?.aborted) onAbort();
				}),
			]);
			return { output, ...(logical.agentRunId ? { agentRunId: logical.agentRunId } : {}) };
		} catch (error) {
			logical.recordError(error);
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			options.feedback?.unbind(logical);
			await logical.close();
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
