/** Shared pipeline reporting backed by Langfuse; JSONL is failure-only. */
import { Telemetry, type TelemetryOptions } from "../telemetry/runtime.js";
import type { AgentObservation, TelemetryIdentity } from "../observability.js";
import type { StageName, StageReporter, SuppliedInput } from "./types.js";

export interface PipelineTrace {
 readonly pipelineRunId: string;
 readonly telemetry: Telemetry;
 readonly artifactRoot: string;
 readonly localPath?: string;
 readonly traceId: string;
 readonly traceUrl?: string;
 event(eventType: string, payload: Record<string, unknown>): void;
 stage(stage: StageName | "orchestrator", invocationId: string): StageReporter & { inputs(): SuppliedInput[] };
 degraded(): boolean;
 failures(): string[];
 close(): Promise<void>;
}
export interface PipelineTraceOptions {
 taskId: string; pipelineRunId: string; runsDir: string; echo?: boolean;
 telemetry?: TelemetryOptions;
}
export async function createPipelineTrace(options: PipelineTraceOptions): Promise<PipelineTrace> {
 const { taskId, pipelineRunId } = options;
 const telemetry = new Telemetry({ taskId, pipelineRunId }, options.runsDir, options.telemetry, options.echo);
 let sequence = 0;
 const record = (eventType: string, payload: Record<string, unknown>, identity: TelemetryIdentity = {}) => telemetry.record({
  agentRunId: pipelineRunId, sequence: sequence++, piSessionId: null, eventType,
  observedAt: new Date().toISOString(), payload: { type: eventType, pipelineRunId, taskId, ...identity, ...payload },
  identity: { pipelineRunId, taskId, ...identity },
 });
 const reporters = new Map<string, ReturnType<PipelineTrace["stage"]>>();
 return {
  pipelineRunId, telemetry, artifactRoot: telemetry.artifactRoot,
  get localPath() { return telemetry.localPath; },
  get traceId() { return telemetry.traceId; },
  get traceUrl() { return telemetry.traceUrl; },
  event: record,
  stage(stage, invocationId) {
   const existing = reporters.get(invocationId); if (existing) return existing;
   const identity = { pipelineRunId, taskId, stage, stageInvocationId: invocationId };
   const supplied: SuppliedInput[] = [];
   const reporter = {
    event: (eventType: string, payload: Record<string, unknown>) => record(eventType, payload, identity),
    agentIdentity: (attempt: number) => ({ ...identity, attempt }),
    observation: (attempt: number): AgentObservation => ({ identity: { ...identity, attempt }, telemetry }),
    input(input: SuppliedInput) { supplied.push(input); record("stage_input", { input }, identity); },
    inputs: () => supplied,
   };
   reporters.set(invocationId, reporter); return reporter;
  },
  degraded: () => telemetry.degraded, failures: () => [...telemetry.failures], close: () => telemetry.close(),
 };
}
