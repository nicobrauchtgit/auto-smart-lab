import { agentEnvironment } from "../telemetry/metadata.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { SmartContextSession } from "../context/session.js";
import { createHash } from "node:crypto";
import {
	createAgentSession, createBashToolDefinition, createEditToolDefinition,
	createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
	createReadToolDefinition, createWriteToolDefinition, defineTool, SessionManager, SettingsManager,
	type CreateAgentSessionOptions, type ToolDefinition, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { observeAgentSession, type AgentObservation } from "../observability.js";
import type { SuppliedInput } from "../pipeline/types.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { createPipelineResourceLoader } from "../run/session_resources.js";
import type { ChildIdentity, ChildSession } from "./types.js";

export const CHILD_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "write", "edit"] as const;
export type ChildToolName = typeof CHILD_TOOL_NAMES[number];

export interface PiChildOptions {
	cwd: string;
	agentDir: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	prompts: PromptSnapshot;
	/** Explicit common runtime guidance, including Python guidance when applicable. */
	sharedInstructions: readonly RenderedPrompt[];
	/** Full subprocess environment snapshot. No writes to process.env. Never logged. */
	env: Readonly<NodeJS.ProcessEnv>;
	inputs: readonly SuppliedInput[];
	/** Obtain from context.report.observation(attempt). Caller retains sink ownership. */
	observe: AgentObservation;
	tools?: readonly string[];
	/** Controller-supplied tools/guards; never model-selected capabilities. */
	customTools?: readonly ToolDefinition[];
	extensionFactories?: readonly InlineExtension[];
	childInstructions?: RenderedPrompt;
	/** null disables the legacy request wall timer for tool-budgeted scouts. */
	turnTimeoutMs?: number | null;
}

/** Uses Pi's cancellation, streaming, and output truncation with a session-local environment. */
export function createChildBashTool(cwd: string, environment: Readonly<NodeJS.ProcessEnv>) {
	const env = Object.freeze({ ...environment });
	return createBashToolDefinition(cwd, {
		exposeSessionEnvironment: false,
		spawnHook: context => ({ ...context, env: agentEnvironment(env) }),
	});
}

/** No ambient project instructions, skills, extensions, or system-prompt additions. */
export async function loadChildResources(options: {
	cwd: string; agentDir: string; instructions: readonly RenderedPrompt[]; extensionFactories?: readonly InlineExtension[];
}) {
	const settingsManager = SettingsManager.inMemory();
	const systemPrompt = options.instructions.map(prompt => prompt.text).join("\n\n");
	const resourceLoader = createPipelineResourceLoader({
		cwd: options.cwd, agentDir: options.agentDir, settingsManager,
		systemPrompt, systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories: [...(options.extensionFactories ?? [])],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	});
	await resourceLoader.reload();
	return { settingsManager, resourceLoader, systemPrompt };
}

export interface PiChildSession extends ChildSession {
	/**
	 * Forced close for a session that may never settle: disposes the Pi session
	 * (aborting its tools) and releases its observer without waiting for the
	 * active prompt. Later close() calls resolve immediately.
	 */
	terminate(): Promise<void>;
}

/** Each call creates one observed Pi session; follow-ups reuse that session. */
export function createPiChildFactory(options: PiChildOptions): (identity: ChildIdentity, signal: AbortSignal) => Promise<PiChildSession> {
	const env = Object.freeze({ ...options.env });
	const inputs = structuredClone(options.inputs);
	const instructions = [...options.sharedInstructions, (options.childInstructions ?? options.prompts.render("subagents.child", {}))]
		.map(prompt => Object.freeze({ text: prompt.text, reference: Object.freeze({ ...prompt.reference }) }));
	const toolNames = [...new Set(options.tools ?? CHILD_TOOL_NAMES)];
	for (const name of toolNames) if (!(CHILD_TOOL_NAMES as readonly string[]).includes(name) && !options.customTools?.some(tool => tool.name === name)) throw new Error(`Unsupported child tool: ${name}`);
	const timeoutMs = options.turnTimeoutMs === null ? null : options.turnTimeoutMs ?? HARNESS_CONFIG.subagents.turnTimeoutMs;
	if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) throw new Error("Invalid child turn timeout");
	const identity = { ...options.observe.identity };
	const observe = { identity, telemetry: options.observe.telemetry };
	// Snapshot declarative values; do not consult a mutable pipeline config on follow-up.
	const { cwd, agentDir, model, modelRuntime, thinkingLevel } = options;

	return async (child: ChildIdentity, signal: AbortSignal) => {
		signal.throwIfAborted();
		const childEnv = {
			...env, PIPELINE_PYTHON_SESSION_ID: child.logicalAgentId,
			PIPELINE_LOGICAL_AGENT_ID: child.logicalAgentId,
			PIPELINE_PARENT_AGENT_RUN_ID: child.parentAgentRunId,
			...(identity.pipelineRunId ? { PIPELINE_RUN_ID: identity.pipelineRunId } : {}),
			...(identity.stageInvocationId ? { PIPELINE_STAGE_INVOCATION_ID: identity.stageInvocationId } : {}),
			...(identity.attempt != null ? { PIPELINE_AGENT_ATTEMPT: String(identity.attempt) } : {}),
		};
		const logical = new SmartContextSession({
			prompts: options.prompts,
			create: async () => {
				signal.throwIfAborted();
				const { settingsManager, resourceLoader, systemPrompt } = await loadChildResources({ cwd, agentDir, instructions, extensionFactories: options.extensionFactories });
				signal.throwIfAborted();
				const availableTools = [
					defineTool(createReadToolDefinition(cwd)), defineTool(createGrepToolDefinition(cwd)), defineTool(createFindToolDefinition(cwd)),
					defineTool(createLsToolDefinition(cwd)), defineTool(createChildBashTool(cwd, childEnv)),
					defineTool(createWriteToolDefinition(cwd)), defineTool(createEditToolDefinition(cwd)),
				];
				const { session } = await createAgentSession({
					cwd, agentDir, model, modelRuntime, thinkingLevel, settingsManager, resourceLoader,
					sessionManager: SessionManager.inMemory(cwd), tools: [...toolNames],
					customTools: [...new Map([...availableTools, ...(options.customTools ?? [])].map(tool => [tool.name, tool])).values()].filter(tool => toolNames.includes(tool.name)),
				});
				let observer: Awaited<ReturnType<typeof observeAgentSession>>;
				try { observer = await observeAgentSession({ session, model: `${model.provider}/${model.id}`, ...observe, parentAgentRunId: child.parentAgentRunId }); }
				catch (error) { session.dispose(); throw error; }
				let disposed = false;
				const dispose = () => { if (!disposed) { disposed = true; session.dispose(); } };
				observer.record("subagent_link", { ...child });
				observer.record("runtime_input", { type: "runtime_input", version: 1,
					inputs, cwd, tools: toolNames, turnTimeoutMs: timeoutMs });
				return {
					session, agentRunId: observer.agentRunId,
					record(type, payload) {
						observer.record(type, payload);
						if (type === "context_prompt") {
							const message = (payload as { prompt: RenderedPrompt }).prompt;
							observer.record("prompt_snapshot", {
								type: "prompt_snapshot", ...child,
								prompts: [...instructions.map(prompt => prompt.reference), message.reference],
								system_prompt: systemPrompt, initial_prompt: message.text,
								effective_system_prompt: session.systemPrompt,
								effective_system_prompt_sha256: createHash("sha256").update(session.systemPrompt).digest("hex"),
							});
						}
					},
					async close() { try { await observer.close(); } finally { dispose(); } },
					// A stuck session may never become idle: dispose it before releasing the observer.
					async terminate() { try { dispose(); } finally { await observer.close(); } },
				};
			},
		});
		let closing: Promise<void> | undefined;
		const abort = () => logical.abort();
		const onAbort = () => { void abort().catch(() => undefined); };
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		return {
			get agentRunId() { return logical.agentRunId ?? ""; },
			get piSessionId() { return logical.piSessionId ?? ""; },
			async prompt(message: RenderedPrompt) {
				if (closing) throw new Error("Child session is closed");
				signal.throwIfAborted();
				let timedOut = false;
				const timer = timeoutMs === null ? undefined : setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
				try {
					const output = await logical.prompt(message);
					signal.throwIfAborted();
					if (timedOut) throw new Error("Child request timed out");
					return output;
				} finally { clearTimeout(timer); }
			},
			abort,
			close: () => closing ??= (async () => {
				signal.removeEventListener("abort", onAbort);
				await logical.close();
			})(),
			terminate: async () => {
				closing ??= Promise.resolve();
				signal.removeEventListener("abort", onAbort);
				await logical.terminate();
			},
		};
	};
}
