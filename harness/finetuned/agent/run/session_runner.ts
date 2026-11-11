import { sessionEnvironment } from "../training/environment.js";
import { webSearchExtension } from "../tools/web_search.js";
import { agentEnvironment } from "../telemetry/metadata.js";
import type { InvocationFeedback } from "../pipeline/feedback.js";
/**
 * Shared helper: run a pi agent session with a given system prompt and initial user message.
 * Returns the collected assistant text from the completed run.
 *
 * Uses the PI SDK with the project pipeline configuration.
 */

import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initializeModel } from "../model_provider.js";
import { promptWithStallRetries, StallWatch } from "./stall.js";
import { observeAgentSession, type AgentObservation } from "../observability.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPipelineResourceLoader } from "./session_resources.js";
import type { PromptReference, PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { TOOL_PROMPTS_SHA256 } from "../prompts/tools.js";
import { preparePythonEnvironment, pythonChangeCursor, recordPythonEnvironmentEnd, readPythonEnvironment } from "./python_environment.js";
import { SmartContextSession } from "../context/session.js";
import type { Wakeable } from "../experiments/index.js";
import { agentBashTool, assertSupervisedBash, bindAgentShells, hostShell, HOST_SHELL_LOG_ROOT } from "./agent_shell.js";
import type { SuppliedInput } from "../pipeline/types.js";

/** How long one agent session may run. The cost signal is measured against it. */
/** Safety limit only; slow progressing sessions are bounded by stall detection and stage budgets. */
export const SESSION_MAX_WALL_MS = HARNESS_CONFIG.session.maxWallMs;

export interface RunSessionOptions {
	/** Fresh controller state queued at every physical session construction. */
	sessionContext?: () => string;
	prompts: PromptSnapshot;
 feedback?: InvocationFeedback;
	reportInput?: (input: SuppliedInput) => void;
	/** Rendered from the run's immutable prompt snapshot. */
	system: RenderedPrompt;
	promptReferences: PromptReference[];
	/** Initial user message to send */
	prompt: string;
	/** Session-local environment supplied to tool factories and child process hooks */
	env?: Record<string, string>;
	/** Optional provider/model reference from pipeline.config.json */
	model?: string;
	/** Built-in tools exposed to the session. Omit for the normal solver/eval set. */
	tools?: string[];
	/** Scoped tools supplied by the caller, such as harness-owned experiment controls. */
	customTools?: ToolDefinition[];
	/** Bind services after observation, including every replacement. Use identity to rebind subagent parents. */
	onSessionReady?: (session: Wakeable, identity: { agentRunId?: string; piSessionId: string }) => void | Promise<void>;
	/** Whether explicitly selected file extensions should be loaded. Defaults to true. */
	extensions?: boolean;
	/** Explicit extension allowlist. Defaults to empty; settings never add extensions. */
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
	/**
	 * Called whenever the agent ends its turn. Returning a prompt resumes the
	 * same conversation; returning undefined ends the session.
	 */
	continueWhenIdle?: (signal?: AbortSignal) => Promise<RenderedPrompt | undefined>;
	/**
	 * Identity of this session's Python dependency changes. Callers that hand
	 * the session a python_environment tool pass the same ID to that tool so
	 * packages it adds are attributed to this session. Defaults to a new ID.
	 */
	pythonSessionId?: string;
	/** Test seams; production uses harness.config.json session settings. */
	stallMs?: number;
	stallRetries?: number;
	maxWallMs?: number;
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

/** The host shell of a scoped session: supervised, with the session-local environment frozen at construction. */
export function sessionBashTool(cwd: string, environment: Readonly<Record<string, string>>, logRoot = HOST_SHELL_LOG_ROOT): ToolDefinition {
 const frozen = { ...environment };
 return agentBashTool(hostShell(cwd, agentEnvironment(sessionEnvironment(process.env, frozen)), logRoot));
}

/**
 * Run a PI agent session, wait for it to settle, and return the collected output.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
	const { prompt, model: requestedModel } = options;
	const customTools = [...(options.customTools ?? [])];
	// Every shell call of every session is supervised; a bash tool from anywhere else is refused.
	assertSupervisedBash(customTools);
	const changeCursor = pythonChangeCursor();
	const pythonSessionId = options.pythonSessionId ?? randomUUID();
	const initialEnvironment = readPythonEnvironment();
	const python = preparePythonEnvironment(options.prompts, initialEnvironment);
	options.reportInput?.(python.input);
	const identity = options.observe?.identity;
	const env: Record<string, string> = {
		...options.env, ...python.env,
		PIPELINE_PYTHON_SESSION_ID: pythonSessionId,
		...(identity?.pipelineRunId ? { PIPELINE_RUN_ID: identity.pipelineRunId } : {}),
		...(identity?.stageInvocationId ? { PIPELINE_STAGE_INVOCATION_ID: identity.stageInvocationId } : {}),
		...(identity?.attempt !== undefined && identity.attempt !== null ? { PIPELINE_AGENT_ATTEMPT: String(identity.attempt) } : {}),
	};

	{
		const systemPrompt = [options.system.text, python.prompt.text].join("\n\n");
		const pipeline = await loadPipelineConfig();
		const { cwd, agentDir } = pipeline;
		const sessionCwd = options.cwd ? resolve(options.cwd) : cwd;
  if ((options.tools === undefined || options.tools.includes("bash")) && !customTools.some(tool => tool.name === "bash")) {
   customTools.push(sessionBashTool(sessionCwd, env, join(HOST_SHELL_LOG_ROOT, pythonSessionId)));
  }
		const requestedExtensions = options.extensionPaths ?? [];
        const webPaths = requestedExtensions.filter(path => /(?:^|[/\\])web_search\.(?:ts|js)$/.test(path));
        const extensionPaths = requestedExtensions.filter(path => !webPaths.includes(path));
        const searchFactories: InlineExtension[] = options.extensions === false || !webPaths.length ? [] : [{ name: "session-web-search", factory: webSearchExtension({
            env: sessionEnvironment(process.env, env),
            maxCalls: Number(env.WEB_SEARCH_MAX_CALLS ?? process.env.WEB_SEARCH_MAX_CALLS ?? Number.MAX_SAFE_INTEGER),
            maxResults: Number(env.WEB_SEARCH_MAX_RESULTS ?? process.env.WEB_SEARCH_MAX_RESULTS ?? 5),
            logPath: env.WEB_SEARCH_LOG,
        }) }];

		const resourceLoader = createPipelineResourceLoader({
			cwd: sessionCwd,
			agentDir,
			additionalExtensionPaths: options.extensions === false ? [] : extensionPaths,
			extensionFactories: [...(options.extensionFactories ?? []), ...searchFactories, ...(options.observe?.executionGuard ? [{ name: "controller-budget", factory(pi: any) { pi.on("tool_call", () => { try { options.observe!.executionGuard!.beforeToolCall(); } catch { return { block: true, reason: "Controller tool budget exhausted" }; } }); } }] : [])],
			systemPrompt,
		});

		await resourceLoader.reload();

		const { modelId, modelRuntime, model } = await initializeModel({
			config: pipeline.config,
			model: requestedModel,
		});
		let physical: AgentSession | undefined;
		let stallObservability: ((type: string, payload: Record<string, unknown>) => void) | undefined;
		const stallMs = options.stallMs ?? HARNESS_CONFIG.session.stallMs;
		const stall = new StallWatch(stallMs, silentMs => {
			stallObservability?.("model_stall", { silent_ms: silentMs, stall_ms: stallMs });
			void physical?.abort();
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
				physical = session;
				session.subscribe(event => stall.observe(event as { type: string; message?: { role?: string } }));
				const previousPayload = session.agent.onPayload;
				session.agent.onPayload = async (payload, selectedModel) => {
					options.observe?.executionGuard?.beforeModelRequest();
					stall.requestStarted();
					return await previousPayload?.(payload, selectedModel) ?? payload;
				};
				let observability: Awaited<ReturnType<typeof observeAgentSession>> | undefined;
				try {
					observability = options.observe ? await observeAgentSession({
						session, model: modelId, identity: options.observe.identity, telemetry: options.observe.telemetry,
					}) : undefined;
					stallObservability = observability?.record;
					observability?.record("prompt_snapshot", {
						type: "prompt_snapshot",
						prompts: [...options.promptReferences, python.prompt.reference, opening.reference],
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
					// Shell findings go to this session, under its observability identity.
					bindAgentShells(customTools, { session: logical, record: observability?.record, prompts: options.prompts });
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
			const maxWallMs = options.maxWallMs ?? SESSION_MAX_WALL_MS;
			const stallRetries = options.stallRetries ?? HARNESS_CONFIG.session.stallRetries;
			stall.start();
			// A stalled request is cancelled and resumed in the same conversation, a bounded number of times.
			const ask = (first: RenderedPrompt) => promptWithStallRetries({
				prompt: request => logical.prompt(request),
				first,
				resume: () => options.prompts.render("context.stall-resume", { stallMinutes: String(Math.round(stallMs / 60000)) }),
				watch: stall, retries: stallRetries, stallMs, signal: options.signal,
				record: (type, payload) => stallObservability?.(type, payload),
			});
			// The work runs under the session's safety limit.
			const work = (async () => {
				let output = await ask(options.prompts.render("context.task", { task: prompt }));
				// A caller may keep an idle session open, e.g. while its experiments run.
				for (let next = await options.continueWhenIdle?.(options.signal); next; next = await options.continueWhenIdle?.(options.signal)) {
					output = await ask(next);
				}
				return output;
			})();
            await options.feedback?.bind(logical);
			const cancelled = new Promise<never>((_, reject) => {
				onAbort = () => reject(new Error("Session cancelled"));
				options.signal?.addEventListener("abort", onAbort, { once: true });
				if (options.signal?.aborted) onAbort();
			});
			cancelled.catch(() => {});
			const wallLimit = new Error(`Session reached its safety limit of ${Math.round(maxWallMs / 60000)} minutes`);
			let output = "";
			try {
				output = await Promise.race([work, cancelled,
					new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(wallLimit), maxWallMs); })]);
			} finally { if (timeout) clearTimeout(timeout); }
			return { output, ...(logical.agentRunId ? { agentRunId: logical.agentRunId } : {}) };
		} catch (error) {
			logical.recordError(error);
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
			stall.stop();
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
			options.feedback?.unbind(logical);
			await logical.close();
		}
	}
}
