import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { SubagentManager } from "./manager.js";
import { DEFAULT_LIMITS } from "./types.js";

/** Only attach these tools to the parent. Children receive a fixed tool allowlist. */
export function createSubagentTools(source: SubagentManager | (() => SubagentManager), prompts: PromptSnapshot,
	maxMessageBytes = typeof source === "function" ? DEFAULT_LIMITS.maxMessageBytes : source.limits.maxMessageBytes) {
	const manager = () => typeof source === "function" ? source() : source;
	const id = Type.String({ minLength: 1, maxLength: 128 });
	const message = Type.String({ minLength: 1, maxLength: maxMessageBytes });
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
	return [
		defineTool({
			name: "subagent_spawn", label: "Spawn child",
			description: prompts.render("subagents.spawn-tool", {}).text,
			parameters: Type.Object({ task: message }),
			async execute(toolCallId, args, signal) { signal?.throwIfAborted(); return result(manager().spawn(args.task, toolCallId)); },
		}),
		defineTool({
			name: "subagent_check", label: "Check child",
			description: prompts.render("subagents.check-tool", {}).text,
			parameters: Type.Object({ id }),
			async execute(_toolCallId, args) { return result(manager().check(args.id)); },
		}),
		defineTool({
			name: "subagent_list", label: "List children",
			description: prompts.render("subagents.list-tool", {}).text,
			parameters: Type.Object({}),
			async execute() { return result(manager().list()); },
		}),
		defineTool({
			name: "subagent_wait", label: "Wait for child",
			description: prompts.render("subagents.wait-tool", {}).text,
			parameters: Type.Object({ id, timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })) }),
			async execute(_toolCallId, args, signal) { return result(await manager().wait(args.id, args.timeoutMs, signal)); },
		}),
		defineTool({
			name: "subagent_followup", label: "Follow up with child",
			description: prompts.render("subagents.followup-tool", {}).text,
			parameters: Type.Object({ id, message }),
			async execute(toolCallId, args, signal) { signal?.throwIfAborted(); return result(manager().followup(args.id, args.message, toolCallId)); },
		}),
		defineTool({
			name: "subagent_cancel", label: "Cancel child",
			description: prompts.render("subagents.cancel-tool", {}).text,
			parameters: Type.Object({ id }),
			async execute(_toolCallId, args) { return result(await manager().cancel(args.id)); },
		}),
	];
}
