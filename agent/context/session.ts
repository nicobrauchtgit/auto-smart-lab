/** Logical sessions survive physical Pi context replacement at tool-safe boundaries. */

import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot, RenderedPrompt, PromptReference } from "../prompts/loader.js";
import type { Wakeable } from "../experiments/index.js";

export const CONTEXT_HANDOFF_TOKENS = HARNESS_CONFIG.context.handoffTokens;
const MAX_HANDOFF_BYTES = HARNESS_CONFIG.context.maxHandoffBytes;

export interface ContextSessionHandle {
	session: AgentSession;
	agentRunId?: string;
	record(type: string, payload: unknown): void;
	close(): Promise<void>;
}
export interface ContextSessionOptions {
	prompts: PromptSnapshot;
	create(prompt: RenderedPrompt): Promise<ContextSessionHandle>;
	/** Test seam; production uses harness.config.json context.handoffTokens. */
	thresholdTokens?: number;
}

export class SmartContextSession implements Wakeable {
	private current?: ContextSessionHandle;
	private rotating = false;
	private running = false;
	private stopped = false;
	private closed = false;
	private pending: string[] = [];
	private feedback = new Map<string, { text: string; delivered: () => void; promptReference?: PromptReference; generation?: number }>();
	async deliverFeedback(id: string, text: string, delivered: () => void, promptReference?: PromptReference): Promise<boolean> {
	if (this.closed || this.stopped || !this.running) return false;
	if (!this.feedback.has(id)) this.feedback.set(id, { text, delivered, promptReference });
	// Admit only at a naturally scheduled request boundary; never wake a final response.
	return true;
	}

	private task?: string;
	private generation = 0;
	private readonly logicalSessionId = randomUUID();
	private readonly handoffPrompt: RenderedPrompt;
	private readonly threshold: number;
	private active?: Promise<string>;

	constructor(private readonly options: ContextSessionOptions) {
		this.threshold = options.thresholdTokens ?? CONTEXT_HANDOFF_TOKENS;
		if (!Number.isSafeInteger(this.threshold) || this.threshold <= 0) throw new Error("Invalid context threshold");
		this.handoffPrompt = options.prompts.render("context.handoff", {});
	}
	get agentRunId() { return this.current?.agentRunId; }
	get piSessionId() { return this.current?.session.sessionId; }
	get isStreaming() { return this.running; }

	/** Updates are buffered across the tool-free handoff and physical-session switch. */
	async steer(text: string): Promise<void> {
		if (this.closed || this.stopped) return;
		if (this.rotating || !this.current || !this.running) this.pending.push(text);
		else await this.current.session.steer(text);
	}
	async sendCustomMessage(message: Parameters<Wakeable["sendCustomMessage"]>[0]): Promise<void> {
		await this.steer(message.content);
	}

	prompt(request: RenderedPrompt): Promise<string> {
		if (this.running) return Promise.reject(new Error("Logical session already running"));
		if (this.closed || this.stopped) return Promise.reject(new Error("Logical session stopped"));
		this.running = true;
		this.task ??= request.text;
		this.active = this.run(request).finally(() => { this.running = false; });
		return this.active;
	}

	private async create(opening: RenderedPrompt): Promise<ContextSessionHandle> {
		const handle = await this.options.create(opening);
		handle.record("runtime_input", { type: "runtime_input", input: {
			kind: "context_policy", version: 1, delivery: "none", status: "available",
			thresholdTokens: this.threshold, boundary: "completed_tool_batch", automaticCompaction: false,
			logicalSessionId: this.logicalSessionId, generation: this.generation,
		} });
		return handle;
	}

	private checkStopped(): void {
		if (this.stopped || this.closed) throw new Error("Session cancelled");
	}
	private checkResponse(session: AgentSession): void {
		const last = [...session.messages].reverse().find(message => message.role === "assistant");
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
			throw new Error(`Model session failed: ${last.errorMessage ?? last.stopReason}`);
		}
	}
	private async run(request: RenderedPrompt): Promise<string> {
		let opening = request;
		try {
			for (;;) {
				this.checkStopped();
				if (!this.current) this.current = await this.create(opening);
				this.checkStopped();
				const handle = this.current;
				const session = handle.session;
				// In-memory override: never change the user's persisted Pi settings.
				session.settingsManager.applyOverrides({ compaction: { enabled: false } });
				const previousTransform = session.agent.transformContext;
				session.agent.transformContext = async (messages, signal) => {
					// Inject typed messages only when the SDK is already assembling a request.
					// Steering queues can themselves wake a completed agent; this path cannot.
					if (!this.rotating && !this.stopped && !this.closed) for (const [id, item] of this.feedback) {
						if (item.generation === this.generation) continue;
						item.generation = this.generation;
						const message = { role: "custom" as const, customType: "stage-feedback", content: item.text,
							display: true, details: { feedbackId: id }, timestamp: Date.now() };
						messages.push(message);
						if (session.agent.state.messages !== messages) session.agent.state.messages.push(message);
						session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
						handle.record("stage_feedback_request", { feedbackId: id, content: item.text, prompt: item.promptReference,
							logicalSessionId: this.logicalSessionId, generation: this.generation });
					}
					const effective = await previousTransform?.(messages, signal) ?? messages;
					if (!this.rotating && !this.stopped && !this.closed) for (const message of effective) {
						if (message.role !== "custom" || message.customType !== "stage-feedback") continue;
						const id = (message.details as { feedbackId?: string })?.feedbackId;
						const item = id ? this.feedback.get(id) : undefined;
						if (item) { item.delivered(); this.feedback.delete(id!); }
					}
					return effective;
				};
				const previousStop = session.agent.shouldStopAfterTurn;
				let thresholdReached = false;
				session.agent.shouldStopAfterTurn = async (context, signal) => {
					if (this.rotating) return true;
					const usage = session.getContextUsage();
					handle.record("context_usage", { ...usage, thresholdTokens: this.threshold,
						logicalSessionId: this.logicalSessionId, generation: this.generation });
					if (usage?.tokens != null && usage.tokens >= this.threshold) {
						thresholdReached = true;
						this.rotating = true;
						return true;
					}
					return await previousStop?.(context, signal) ?? false;
				};
				try {
					handle.record("context_prompt", { prompt: opening, logicalSessionId: this.logicalSessionId, generation: this.generation });
					// Queue updates only after prompt() has admitted the opening message.
					const response = session.prompt(opening.text);
					for (const update of this.pending.splice(0)) await session.steer(update);
					await response;
					this.checkStopped();
					this.checkResponse(session);
					if (!thresholdReached) return session.getLastAssistantText() ?? "";

					const handoffId = randomUUID();
					handle.record("context_handoff_started", { handoffId, logicalSessionId: this.logicalSessionId,
						generation: this.generation, thresholdTokens: this.threshold, prompt: this.handoffPrompt.reference });
					const queued = session.clearQueue();
					this.pending.unshift(...queued.steering, ...queued.followUp);
					// The old session can summarize, but cannot start new work.
					session.setActiveToolsByName([]);
					// Some OpenAI-compatible endpoints (including KISSKI) reject tools: [].
					// Keep existing payload hooks, then omit the empty declaration for this request.
					const previousPayload = session.agent.onPayload;
					session.agent.onPayload = async (payload, model) => {
						const effective = await previousPayload?.(payload, model) ?? payload;
						return omitEmptyTools(effective);
					};
					try { await session.prompt(this.handoffPrompt.text); }
					finally { session.agent.onPayload = previousPayload; }
					this.checkStopped();
					this.checkResponse(session);
					const last = session.messages.at(-1);
					if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error("Context handoff did not finish normally");
					const handoff = session.getLastAssistantText()?.trim();
					if (!handoff || Buffer.byteLength(handoff) > MAX_HANDOFF_BYTES) throw new Error("Empty or oversized context handoff");
					const late = session.clearQueue();
					this.pending.push(...late.steering, ...late.followUp);
					opening = this.options.prompts.render("context.resume", {
						task: this.task!, request: request.text, handoff, updates: this.pending.splice(0).join("\n\n"),
					});
					handle.record("context_handoff_completed", { handoffId, logicalSessionId: this.logicalSessionId,
						generation: this.generation, handoff, sha256: createHash("sha256").update(handoff).digest("hex") });
					const previous = { agentRunId: handle.agentRunId, piSessionId: session.sessionId };
					await handle.close();
					this.current = undefined;
					this.checkStopped();
					this.generation++;
					this.current = await this.create(opening);
					this.current.record("context_handoff_resumed", { handoffId, logicalSessionId: this.logicalSessionId,
						generation: this.generation, previous });
					this.rotating = false;
				} finally { session.agent.shouldStopAfterTurn = previousStop; session.agent.transformContext = previousTransform; }
			}
		} catch (error) {
			this.current?.record("context_session_failed", { logicalSessionId: this.logicalSessionId,
				generation: this.generation, handoff: this.rotating, message: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	recordError(error: unknown): void {
		this.current?.record("runner_error", { message: error instanceof Error ? error.message : String(error) });
	}

	async abort(): Promise<void> {
		this.stopped = true;
		await this.current?.session.abort();
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.abort();
		await this.active?.catch(() => undefined);
		await this.current?.close();
	}
}

/** Omission is the portable wire representation of a tool-free handoff. */
export function omitEmptyTools(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const value = payload as Record<string, unknown>;
	if (!Array.isArray(value.tools) || value.tools.length !== 0) return payload;
	const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = value;
	return rest;
}
