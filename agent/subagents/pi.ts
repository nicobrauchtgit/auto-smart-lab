import { createHash } from "node:crypto";
import {
	createAgentSession, createBashToolDefinition, createEditToolDefinition,
	createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
	createReadToolDefinition, createWriteToolDefinition, defineTool, SessionManager, SettingsManager,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { observeAgentSession, type AgentObservation } from "../observability.js";
import type { SuppliedInput } from "../pipeline/types.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { createPipelineResourceLoader } from "../run/session_resources.js";
import type { ChildIdentity, ChildSessionFactory } from "./types.js";

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
	tools?: readonly ChildToolName[];
	turnTimeoutMs?: number;
}

/** Uses Pi's cancellation, streaming, and output truncation with a session-local environment. */
export function createChildBashTool(cwd: string, environment: Readonly<NodeJS.ProcessEnv>) {
	const env = Object.freeze({ ...environment });
	return createBashToolDefinition(cwd, {
		exposeSessionEnvironment: false,
		spawnHook: context => ({ ...context, env: { ...env } }),
	});
}

/** No ambient project instructions, skills, extensions, or system-prompt additions. */
export async function loadChildResources(options: {
	cwd: string; agentDir: string; instructions: readonly RenderedPrompt[];
}) {
	const settingsManager = SettingsManager.inMemory();
	const systemPrompt = options.instructions.map(prompt => prompt.text).join("\n\n");
	const resourceLoader = createPipelineResourceLoader({
		cwd: options.cwd, agentDir: options.agentDir, settingsManager,
		systemPrompt, systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	});
	await resourceLoader.reload();
	return { settingsManager, resourceLoader, systemPrompt };
}

/** Each call creates one observed Pi session; follow-ups reuse that session. */
export function createPiChildFactory(options: PiChildOptions): ChildSessionFactory {
	const env = Object.freeze({ ...options.env });
	const inputs = structuredClone(options.inputs);
	const instructions = [...options.sharedInstructions, options.prompts.render("subagents.child", {})]
		.map(prompt => Object.freeze({ text: prompt.text, reference: Object.freeze({ ...prompt.reference }) }));
	const toolNames = [...new Set(options.tools ?? CHILD_TOOL_NAMES)];
	for (const name of toolNames) if (!CHILD_TOOL_NAMES.includes(name)) throw new Error(`Unsupported child tool: ${name}`);
	const timeoutMs = options.turnTimeoutMs ?? 30 * 60 * 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid child turn timeout");
	const identity = { ...options.observe.identity };
	const observe = { identity, sink: options.observe.sink };
	// Snapshot declarative values; do not consult a mutable pipeline config on follow-up.
	const { cwd, agentDir, model, modelRuntime, thinkingLevel } = options;

	return async (child: ChildIdentity, signal: AbortSignal) => {
		signal.throwIfAborted();
		const { settingsManager, resourceLoader, systemPrompt } = await loadChildResources({ cwd, agentDir, instructions });
		signal.throwIfAborted();
		const childEnv = {
			...env,
			PIPELINE_PYTHON_SESSION_ID: child.logicalAgentId,
			PIPELINE_LOGICAL_AGENT_ID: child.logicalAgentId,
			PIPELINE_PARENT_AGENT_RUN_ID: child.parentAgentRunId,
			...(identity.pipelineRunId ? { PIPELINE_RUN_ID: identity.pipelineRunId } : {}),
			...(identity.stageInvocationId ? { PIPELINE_STAGE_INVOCATION_ID: identity.stageInvocationId } : {}),
			...(identity.attempt != null ? { PIPELINE_AGENT_ATTEMPT: String(identity.attempt) } : {}),
		};
		const availableTools = [
			defineTool(createReadToolDefinition(cwd)), defineTool(createGrepToolDefinition(cwd)), defineTool(createFindToolDefinition(cwd)),
			defineTool(createLsToolDefinition(cwd)), defineTool(createChildBashTool(cwd, childEnv)),
			defineTool(createWriteToolDefinition(cwd)), defineTool(createEditToolDefinition(cwd)),
		];
		const { session } = await createAgentSession({
			cwd, agentDir, model, modelRuntime, thinkingLevel, settingsManager, resourceLoader,
			sessionManager: SessionManager.inMemory(cwd), tools: toolNames,
			customTools: availableTools.filter(tool => toolNames.includes(tool.name as ChildToolName)),
		});
		let observer: Awaited<ReturnType<typeof observeAgentSession>>;
		try {
			observer = await observeAgentSession({ session, model: `${model.provider}/${model.id}`, ...observe });
		} catch (error) { session.dispose(); throw error; }
		let closing: Promise<void> | undefined;
		const abort = async () => { await session.abort(); };
		const onAbort = () => { void abort().catch(error => observer.recordError(error)); };
		signal.addEventListener("abort", onAbort, { once: true });
		const close = () => closing ??= (async () => {
			signal.removeEventListener("abort", onAbort);
			try { await abort(); }
			finally {
				try { await observer.close(); }
				finally { session.dispose(); }
			}
		})();
		try {
			signal.throwIfAborted();
			observer.record("subagent_link", { ...child });
			observer.record("runtime_input", { type: "runtime_input", version: 1,
				inputs, cwd, tools: toolNames, turnTimeoutMs: timeoutMs });
			return {
				agentRunId: observer.agentRunId,
				piSessionId: session.sessionId,
				async prompt(message: RenderedPrompt) {
					if (closing) throw new Error("Child session is closed");
					signal.throwIfAborted();
					observer.record("prompt_snapshot", {
						type: "prompt_snapshot", ...child,
						prompts: [...instructions.map(prompt => prompt.reference), message.reference],
						system_prompt: systemPrompt, initial_prompt: message.text,
						effective_system_prompt: session.systemPrompt,
						effective_system_prompt_sha256: createHash("sha256").update(session.systemPrompt).digest("hex"),
					});
					let timedOut = false;
					const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
					try {
						await session.prompt(message.text);
						signal.throwIfAborted();
						if (timedOut) throw new Error("Child request timed out");
						const last = [...session.messages].reverse().find(message => message.role === "assistant");
						if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
							throw new Error(last.errorMessage ?? `Child request ${last.stopReason}`);
						}
						return session.getLastAssistantText() ?? "";
					} catch (error) { observer.recordError(error); throw error; }
					finally { clearTimeout(timer); }
				},
				abort,
				close,
			};
		} catch (error) { await close(); throw error; }
	};
}
