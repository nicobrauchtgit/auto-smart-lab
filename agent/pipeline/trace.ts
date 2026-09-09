/**
 * Observability for pipeline runs.
 *
 * Every event of a run — stage lifecycle, supplied inputs, artifact validation, and
 * each agent attempt — is written through one sink under a shared pipeline run ID,
 * so a run stays readable even when it contains several agent sessions.
 */

import { join } from "node:path";

import { createEventSink, type AgentObservation, type EventIdentity, type EventSink } from "../observability.js";
import type { StageName, StageReporter, SuppliedInput } from "./types.js";

export interface PipelineTrace {
	readonly pipelineRunId: string;
	readonly sink: EventSink;
	readonly localPath: string;
	event(eventType: string, payload: Record<string, unknown>): void;
	stage(stage: StageName, invocationId: string): StageReporter & { inputs(): SuppliedInput[] };
	degraded(): boolean;
	failures(): string[];
	close(): Promise<void>;
}

export interface PipelineTraceOptions {
	taskId: string;
	pipelineRunId: string;
	/** Directory for the local JSON-lines mirror. */
	runsDir: string;
	echo?: boolean;
}

/**
 * Name a trace by when it ran, then by which run it was.
 *
 * A bare run id says nothing at a directory listing: telling two runs apart
 * meant sorting by mtime and opening them. Leading with a sortable timestamp
 * makes the ordering the file name's job, and the id suffix keeps it unique.
 */
export function traceFileName(pipelineRunId: string, at: Date = new Date()): string {
	const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, (match) => (match === "T" ? "-" : ""));
	return `${stamp}-${pipelineRunId.slice(0, 8)}`;
}

export async function createPipelineTrace(options: PipelineTraceOptions): Promise<PipelineTrace> {
	const { taskId, pipelineRunId } = options;
	const localPath = join(options.runsDir, taskId, "pipeline", `${traceFileName(pipelineRunId)}.jsonl`);
	const sink = await createEventSink({ localPath, echo: options.echo ?? false });
	if (!sink.databaseConnected) {
		console.warn(`[trace] Database unavailable; events are only mirrored to ${localPath}`);
	}

	let sequence = 0;
	function record(eventType: string, payload: Record<string, unknown>, identity: EventIdentity): void {
		sink.record({
			agentRunId: pipelineRunId,
			sequence: sequence++,
			piSessionId: null,
			eventType,
			observedAt: new Date().toISOString(),
			payload: { type: eventType, pipelineRunId, taskId, ...identity, ...payload },
			identity: { pipelineRunId, taskId, ...identity },
		});
	}

	return {
		pipelineRunId,
		sink,
		localPath,
		event(eventType, payload) {
			record(eventType, payload, {});
		},
		stage(stage, invocationId) {
			const identity: EventIdentity = { stage, stageInvocationId: invocationId };
			const supplied: SuppliedInput[] = [];
			return {
				event(eventType, payload) {
					record(eventType, payload, identity);
				},
				agentIdentity(attempt) {
					return { pipelineRunId, taskId, ...identity, attempt };
				},
				observation(attempt): AgentObservation {
					return { identity: { pipelineRunId, taskId, ...identity, attempt }, sink };
				},
				input(input) {
					supplied.push(input);
					record("stage_input", { input }, identity);
				},
				inputs: () => supplied,
			};
		},
		degraded: () => !sink.databaseConnected || sink.failures.length > 0,
		failures: () => [...sink.failures],
		close: () => sink.close(),
	};
}
