/** Pi observations share the controller's Langfuse execution trace. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Telemetry } from "./telemetry/runtime.js";
import type { TelemetryIdentity, TelemetryRecord } from "./telemetry/metadata.js";
export type { TelemetryIdentity, TelemetryRecord } from "./telemetry/metadata.js";

export interface ObservationTelemetry {
 readonly failures: string[];
 record(record: TelemetryRecord): void;
 close(): Promise<void>;
}
export interface ObservabilityOptions {
 session: AgentSession;
 model: string;
 stepType?: string | null;
 identity?: TelemetryIdentity;
 telemetry?: ObservationTelemetry;
 echo?: boolean;
 parentAgentRunId?: string;
}
export async function observeAgentSession(options: ObservabilityOptions) {
 const { session, model } = options;
 const agentRunId = crypto.randomUUID();
 const identity: TelemetryIdentity = { ...options.identity, stage: options.identity?.stage ?? options.stepType ?? null };
 const owned = options.telemetry ? undefined : new Telemetry({ ...identity, pipelineRunId: identity.pipelineRunId ?? crypto.randomUUID() }, "runs", {}, options.echo ?? false);
 const telemetry = options.telemetry ?? owned!;
 if (owned) {
  try { owned.checkLocal(); await owned.checkAccess(new AbortController().signal); }
  catch { await owned.close(); throw new Error("Langfuse setup failed; check project credentials and access before starting the session"); }
 }
 let sequence = 0, closed = false;
 const record = (eventType: string, payload: unknown) => telemetry.record({
  agentRunId, sequence: sequence++, piSessionId: session.sessionId, eventType,
  observedAt: new Date().toISOString(), payload, identity,
 });
 const unsubscribe = session.subscribe(event => record(event.type, event));
 const previousPayload = session.agent.onPayload;
 const requestHook: NonNullable<typeof session.agent.onPayload> = async (payload, selectedModel) => {
  const request = await previousPayload?.(payload, selectedModel) ?? payload;
  record("model_request", { request, model: selectedModel.id, provider: selectedModel.provider });
  return request;
 };
 session.agent.onPayload = requestHook;
 record("agent_run_start", { agentRunId, piSessionId: session.sessionId, model, parentAgentRunId: options.parentAgentRunId, ...identity });
 return { agentRunId, record,
  recordError(_error: unknown) { record("runner_error", { message: "Agent runner failed; inspect the controller error and bounded session results" }); },
  async close() {
   if (closed) return;
   closed = true; unsubscribe();
   if (session.agent.onPayload === requestHook) session.agent.onPayload = previousPayload;
   record("agent_run_end", { agentRunId });
   if (owned) await owned.close();
  },
 };
}
export interface AgentObservation {
 executionGuard?: { beforeSession(): void; beforeModelRequest(): void; beforeToolCall(): void };
 identity: TelemetryIdentity;
 telemetry: ObservationTelemetry;
}
