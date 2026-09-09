import { randomUUID } from "node:crypto";
import { SubagentManager } from "./manager.js";
import { createPiChildFactory, type PiChildOptions } from "./pi.js";
import { createSubagentTools } from "./tools.js";
import type { SubagentLimits } from "./types.js";

export { SubagentManager } from "./manager.js";
export { createPiChildFactory, loadChildResources, createChildBashTool } from "./pi.js";
export { createSubagentTools } from "./tools.js";
export type { PiChildOptions, ChildToolName } from "./pi.js";
export type { ChildSession, ChildSessionFactory, ChildIdentity, ChildView, ChildResult, SubagentLimits } from "./types.js";

/** Opt-in parent scope. Close before releasing the parent's observation sink. */
export function createSubagents(options: PiChildOptions & {
	/** Or call bindParent after attaching the parent observer, before its first prompt. */
	parentAgentRunId?: string;
	limits?: Partial<SubagentLimits>;
	signal?: AbortSignal;
}) {
	options.signal?.throwIfAborted();
	const moduleRunId = randomUUID();
	let sequence = 0;
	const identity = { ...options.observe.identity };
	const sink = options.observe.sink;
	let parentAgentRunId: string | undefined;
	const record = (eventType: string, payload: Record<string, unknown>) => sink.record({
		agentRunId: moduleRunId, piSessionId: null, sequence: sequence++,
		eventType, observedAt: new Date().toISOString(), identity,
		payload: { ...payload, parentAgentRunId },
	});
	const createSession = createPiChildFactory(options);
	const limits = { ...options.limits };
	let manager: SubagentManager | undefined;
	const getManager = () => {
		if (!manager) throw new Error("Bind the observed parent before calling subagent tools");
		return manager;
	};
	const tools = createSubagentTools(getManager, options.prompts, limits.maxMessageBytes);
	const toolPrompts = (["subagents.spawn-tool", "subagents.check-tool", "subagents.list-tool",
		"subagents.wait-tool", "subagents.followup-tool", "subagents.cancel-tool"] as const)
		.map(id => options.prompts.render(id, {}).reference);
	let closing: Promise<void> | undefined;
	const bindParent = (id: string) => {
		if (closing) throw new Error("Subagent scope is closed");
		if (manager) throw new Error("Subagent scope already has a parent");
		if (!id.trim()) throw new Error("Parent agent run ID is required");
		parentAgentRunId = id;
		manager = new SubagentManager({ parentAgentRunId: id, prompts: options.prompts, createSession, limits, record });
		record("subagent_scope_started", { version: 1, limits: manager.limits, toolPrompts });
	};
	const close = () => closing ??= (async () => {
		options.signal?.removeEventListener("abort", onAbort);
		try { await manager?.close(); }
		finally { record("subagent_scope_closed", {}); }
	})();
	const onAbort = () => { void close().catch(error => record("subagent_cleanup_error", { error: String(error) })); };
	if (options.parentAgentRunId) bindParent(options.parentAgentRunId);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	return { get manager() { return getManager(); }, tools, bindParent,
		parentInstructions: options.prompts.render("subagents.parent", {}), close };
}
