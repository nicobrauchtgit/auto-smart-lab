import { boundedText, DEFAULT_LIMITS } from "./types.js";

interface ContentBlock { type: string; text?: string }
interface SmokeMessage {
	role: string;
	toolCallId?: string;
	content?: ContentBlock[];
}
export interface SmokeEvent {
	agent_run_id: string;
	event_type: string;
	payload: {
		toolCallId?: string;
		toolName?: string;
		message?: SmokeMessage;
		result?: { content?: ContentBlock[] };
	};
}

const marker = "CHILD_BASH_ONLY_SMOKE_MARKER";
const replyKeys = new Set(["logicalAgentId", "parentAgentRunId", "spawnToolCallId", "status", "queued",
	"agentRunId", "piSessionId", "error", "output", "truncated"]);
const messageText = (message?: SmokeMessage) => message?.content
	?.filter(block => block.type === "text").map(block => block.text ?? "").join("").trim() ?? "";

/** For the one-child, one-request smoke fixture. Marker presence is not an isolation test. */
export function assessSmokeContext(events: readonly SmokeEvent[], parentId?: string, childId?: string,
	maxResultBytes = DEFAULT_LIMITS.maxResultBytes) {
	const parentEvents = events.filter(event => event.agent_run_id === parentId);
	const childEvents = events.filter(event => event.agent_run_id === childId);
	const childTools = childEvents.filter(event => event.event_type === "tool_execution_end");
	const childToolIds = new Set(childTools.map(event => event.payload.toolCallId).filter(Boolean));
	const finalReply = childEvents.filter(event => event.event_type === "message_end"
		&& event.payload.message?.role === "assistant").at(-1)?.payload.message;
	const expected = boundedText(messageText(finalReply), maxResultBytes);
	const waits = parentEvents.filter(event => event.event_type === "tool_execution_end"
		&& event.payload.toolName === "subagent_wait");
	let completedReplies = 0;
	let validReplies = waits.length > 0 && finalReply !== undefined;
	const replies: { bytes: number; truncated: boolean; markerRepeated: boolean }[] = [];
	for (const event of waits) {
		const content = event.payload.result?.content;
		try {
			if (content?.length !== 1 || content[0].type !== "text") throw new Error("Unexpected wait content");
			const reply = JSON.parse(content[0].text ?? "");
			if (!reply || typeof reply !== "object" || Array.isArray(reply)
				|| Object.keys(reply).some(key => !replyKeys.has(key))
				|| reply.parentAgentRunId !== parentId) throw new Error("Unexpected reply envelope");
			if (reply.status === "running") {
				if (reply.output !== undefined) throw new Error("Running reply contains output");
				continue;
			}
			if (reply.status !== "idle" || reply.agentRunId !== childId
				|| reply.output !== expected.text || reply.truncated !== expected.truncated) {
				throw new Error("Wait did not return the bounded final assistant reply");
			}
			completedReplies++;
			replies.push({ bytes: Buffer.byteLength(reply.output), truncated: reply.truncated,
				markerRepeated: reply.output.includes(marker) });
		} catch { validReplies = false; }
	}
	return {
		checks: {
			childToolEventsStayInChild: Boolean(parentId && childId && parentId !== childId)
				&& childToolIds.size > 0 && !parentEvents.some(event =>
					childToolIds.has(event.payload.toolCallId)
					|| childToolIds.has(event.payload.message?.toolCallId)),
			waitReturnsBoundedFinalReply: validReplies && completedReplies > 0,
		},
		// These describe reply quality separately from automatic transcript forwarding.
		replyQuality: { maxResultBytes, replies,
			markerInParentMessages: JSON.stringify(parentEvents.filter(event =>
				["message_end", "prompt_snapshot"].includes(event.event_type))).includes(marker) },
	};
}
