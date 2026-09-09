import type { RenderedPrompt } from "../prompts/loader.js";

export interface ChildIdentity {
	logicalAgentId: string;
	parentAgentRunId: string;
	spawnToolCallId: string;
}

/** A backend owns one independent context. No streamed output crosses this boundary. */
export interface ChildSession {
	agentRunId: string;
	piSessionId: string;
	prompt(message: RenderedPrompt): Promise<string>;
	abort(): Promise<void>;
	close(): Promise<void>;
}

export type ChildSessionFactory = (identity: ChildIdentity, signal: AbortSignal) => Promise<ChildSession>;

export type ChildStatus = "running" | "idle" | "failed" | "cancelled";

export interface ChildView extends ChildIdentity {
	status: ChildStatus;
	queued: number;
	agentRunId?: string;
	piSessionId?: string;
	error?: string;
}

export interface ChildResult extends ChildView {
	output?: string;
	truncated?: boolean;
}

export interface SubagentLimits {
	maxConcurrent: number;
	maxChildren: number;
	maxQueuedMessages: number;
	maxMessageBytes: number;
	maxResultBytes: number;
}

export const DEFAULT_LIMITS: Readonly<SubagentLimits> = Object.freeze({
	maxConcurrent: 4,
	maxChildren: 32,
	maxQueuedMessages: 8,
	maxMessageBytes: 32 * 1024,
	maxResultBytes: 8 * 1024,
});

export function boundedText(text: string, bytes: number): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return { text, truncated: false };
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}
