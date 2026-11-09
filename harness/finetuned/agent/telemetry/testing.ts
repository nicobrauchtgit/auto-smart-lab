/** In-memory injection for execution tests; never sends fixture content to Cloud. */
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TelemetryOptions, ObservationScore } from "./runtime.js";
import type { TelemetryRecord } from "./metadata.js";
const records: TelemetryRecord[] = [];
const directoryRuns = new Map<string, string>();
export class MemoryExporter implements SpanExporter {
 readonly spans: ReadableSpan[] = [];
 failed = false;
 export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]) {
  this.spans.push(...spans); done({ code: this.failed ? 1 : 0 });
 }
 async shutdown() {}
}
export function testTelemetry(): TelemetryOptions & { exporter: MemoryExporter; scores: ObservationScore[] } {
 const exporter = new MemoryExporter(), scores: ObservationScore[] = [];
 return { exporter, scores,
  config: { publicKey: "test-public", secretKey: "test-secret", baseUrl: "https://cloud.langfuse.com", environment: "test", timeoutMs: 1000 },
  async checkAccess() { return "test-project"; },
  async sendScore(score) { scores.push(score); },
  onRecord(record) { records.push(record); },
 };
}
export function traceEvents(runId: string) {
 return records.filter(record => record.identity?.pipelineRunId === runId).map(record => ({
  agent_run_id: record.agentRunId, pi_session_id: record.piSessionId,
  sequence: record.sequence, event_type: record.eventType, observed_at: record.observedAt,
  pipeline_run_id: record.identity?.pipelineRunId, stage: record.identity?.stage,
  stage_invocation_id: record.identity?.stageInvocationId, attempt: record.identity?.attempt,
  payload: record.payload as any,
 }));
}
export function clearTraceEvents() { records.length = 0; }
export function telemetryForDirectory(directory: string): TelemetryOptions {
 const options = testTelemetry();
 return { ...options, onRecord(record) {
  if (record.identity?.pipelineRunId) directoryRuns.set(directory, record.identity.pipelineRunId);
  options.onRecord!(record);
 } };
}
export function traceEventsForDirectory(directory: string) { return traceEvents(directoryRuns.get(directory) ?? ""); }
