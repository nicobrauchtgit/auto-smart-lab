import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseSpan, LangfuseGeneration, LangfuseAgent, LangfuseTool, LangfuseEvent, LangfuseChain, createObservationAttributes, type LangfuseObservation, type LangfuseObservationAttributes, type LangfuseObservationType } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";
import { checkLangfuseAccess, LangfuseAccessError, telemetryConfig, type TelemetryConfig } from "./config.js";
import { EmergencyJournal } from "./emergency.js";
import { CloudExporter } from "./exporter.js";
import { piUsage, sanitize, sanitizeEventPayload, type TelemetryIdentity, type TelemetryRecord } from "./metadata.js";

export interface ObservationScore {
 id: string; traceId: string; observationId: string; name: string; value: number;
 dataType: "NUMERIC" | "BOOLEAN"; metadata: Record<string, unknown>;
}
/** Injection is a controller/test API, never a model-controlled option. */
export interface TelemetryOptions {
 /** Explicit controller opt-in for an initial service outage; never bypasses credentials. */
 allowFallback?: boolean;
 exporter?: SpanExporter;
 config?: TelemetryConfig;
 checkAccess?: (signal: AbortSignal) => Promise<string>;
 sendScore?: (score: ObservationScore) => Promise<void>;
 onRecord?: (record: TelemetryRecord) => void;
 maxPendingSpans?: number;
}
interface Handle { observation: LangfuseObservation; ended: boolean; metadata: Record<string, unknown> }
const runtimes = new Map<string, Runtime>();
const MAX_BATCH_BYTES = 1024 * 1024;

function spanRecord(span: ReadableSpan) {
 return { name: span.name, context: span.spanContext(), parent: span.parentSpanContext,
  startTime: span.startTime, endTime: span.endTime, attributes: span.attributes, status: span.status };
}

/** One shared SDK provider per configured process, with explicit trace ownership. */
class Runtime {
 readonly provider: NodeTracerProvider;
 readonly owners = new Map<string, Telemetry>();
 readonly pending = new Set<string>();
 private processor: LangfuseSpanProcessor;
 private closing?: Promise<void>;
 constructor(readonly config: TelemetryConfig, readonly options: TelemetryOptions, private released: () => void) {
  const delegate = options.exporter ?? new CloudExporter(config);
  const exporter: SpanExporter = {
   export: (spans, callback) => {
    // A supported exporter hook receives the exact masked batch and its outcome.
    const send = (batch: ReadableSpan[], done: (ok: boolean) => void) => {
     if ((JsonTraceSerializer.serializeRequest(batch)?.byteLength ?? 0) > MAX_BATCH_BYTES) {
      if (batch.length > 1) {
       const middle = Math.ceil(batch.length / 2);
       send(batch.slice(0, middle), first => send(batch.slice(middle), second => done(first && second)));
      } else { this.failed(batch, "observation exceeds export size limit"); done(false); }
      return;
     }
     try {
      delegate.export(batch, result => {
       if (result.code !== 0) this.failed(batch, "Langfuse observation export failed");
       for (const span of batch) this.pending.delete(span.spanContext().spanId);
       done(result.code === 0);
      });
     } catch { this.failed(batch, "Langfuse observation export failed"); done(false); }
    };
    send([...spans], ok => callback({ code: ok ? 0 : 1, ...(ok ? {} : { error: new Error("Langfuse export failed; emergency recording activated") }) }));
   },
   shutdown: () => delegate.shutdown(),
   forceFlush: () => delegate.forceFlush?.() ?? Promise.resolve(),
  };
  this.processor = new LangfuseSpanProcessor({
   ...config, timeout: config.timeoutMs / 1000, exporter, flushAt: 16, flushInterval: 1,
   mediaUploadEnabled: false, environment: config.environment,
  });
  const processor: SpanProcessor = {
   onStart: (span: Span, context: Context) => this.processor.onStart(span, context),
   onEnd: span => {
    if (this.pending.size >= (options.maxPendingSpans ?? 1024)) {
     this.failed([span], "Langfuse observation queue limit reached"); return;
    }
    this.pending.add(span.spanContext().spanId);
    this.processor.onEnd(span);
   },
   forceFlush: () => this.processor.forceFlush(),
   shutdown: () => this.processor.shutdown(),
  };
  // Explicit contexts avoid global provider registration and cross-run leakage.
  this.provider = new NodeTracerProvider({ spanProcessors: [processor],
   spanLimits: { attributeCountLimit: 128, attributeValueLengthLimit: 64000 } });
 }
 private failed(spans: ReadableSpan[], reason: string) {
  for (const span of spans) {
   this.pending.delete(span.spanContext().spanId);
   this.owners.get(span.spanContext().traceId)?.fail(reason, { kind: "failed_observation", span: spanRecord(span) });
  }
 }
 async release(owner: Telemetry) {
  try { await this.provider.forceFlush(); }
  catch { owner.fail("Langfuse flush failed or timed out"); }
  this.owners.delete(owner.traceId);
  if (!this.owners.size) {
   this.released();
   try { await (this.closing ??= this.provider.shutdown()); }
   catch { owner.fail("Langfuse shutdown failed"); }
  }
 }
}

export class Telemetry {
 readonly executionId = randomUUID();
 readonly traceId: string;
 readonly artifactRoot: string;
 readonly failures: string[] = [];
 private runtime: Runtime;
 private config: TelemetryConfig;
 private configMissing = false;
 private projectId?: string;
 private journal: EmergencyJournal;
 private root: Handle;
 private stages = new Map<string, Handle>();
 private attempts = new Map<string, Handle>();
 private sessions = new Map<string, Handle>();
 private tools = new Map<string, Handle>();
 private generations = new Map<string, Handle>();
 private trials = new Map<string, Handle>();
 private setups = new Map<string, Handle>();
 private open = new Set<Handle>();
 private scoreWork = new Set<Promise<void>>();
 private scoreSequence = 0;
 private closed = false;
 private closing?: Promise<void>;
 private client?: LangfuseClient;
 private secrets: string[];

 constructor(readonly identity: TelemetryIdentity, runsDir: string, private options: TelemetryOptions = {}, private echo = false) {
  try { this.config = options.config ?? telemetryConfig(); }
  catch {
   this.configMissing = true;
   this.config = { publicKey: "unconfigured", secretKey: "unconfigured", baseUrl: "https://cloud.langfuse.com", environment: "development", timeoutMs: 5000 };
  }
  this.secrets = [this.config.publicKey, this.config.secretKey,
   ...Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PASSWORD|API_KEY/.test(key)).map(([, value]) => value!).filter(Boolean)];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, match => match === "T" ? "-" : "");
  this.artifactRoot = join(runsDir, identity.taskId ?? "agent", "pipeline", `${stamp}-${this.executionId.slice(0, 8)}`);
  this.journal = new EmergencyJournal(`${this.artifactRoot}.emergency.jsonl`, () => {
   this.addFailure("Emergency trace write failed; local trace coverage unavailable");
  });
  const settings = this.config;
  const key = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  const injected = !!options.exporter;
  this.runtime = !injected && !this.configMissing && runtimes.has(key) ? runtimes.get(key)! : new Runtime(settings,
   this.configMissing ? { ...options, exporter: { export: (_spans, done) => done({ code: 1 }), async shutdown() {} } } : options,
   () => { if (runtimes.get(key) === this.runtime) runtimes.delete(key); });
  if (!injected && !this.configMissing) runtimes.set(key, this.runtime);
  this.root = this.start("pipeline-execution", "chain", undefined, { pipelineRunId: identity.pipelineRunId, taskId: identity.taskId,
   executionId: this.executionId, telemetry_schema_version: 1, release: process.env.LANGFUSE_RELEASE ?? process.env.GIT_COMMIT ?? null }, { input: { ...identity } });
  this.traceId = this.root.observation.traceId;
  this.runtime.owners.set(this.traceId, this);
  if (this.configMissing) this.fail("Langfuse configuration unavailable; setup must pass before execution");
 }
 get localPath(): string | undefined { return this.journal.localPath; }
 get traceUrl(): string | undefined { return this.projectId ? `${this.config.baseUrl}/project/${encodeURIComponent(this.projectId)}/traces/${this.traceId}` : undefined; }
 get degraded(): boolean { return this.failures.length > 0; }
 private addFailure(reason: string) {
  if (!this.failures.includes(reason) && this.failures.length < 20) { this.failures.push(reason); console.warn(`[trace] ${reason}`); }
 }
 fail(reason: string, record?: unknown) {
  this.addFailure(reason);
  this.journal.activate(reason, { ...this.identity, executionId: this.executionId, traceId: this.traceId });
  if (record) this.journal.write(sanitize(record, this.secrets));
 }
 checkLocal() {
  if (this.configMissing) telemetryConfig();
  let path = dirname(this.journal.path);
  while (!existsSync(path)) path = dirname(path);
  if (!statSync(path).isDirectory()) throw new Error("Emergency trace parent must be a directory");
  accessSync(path, constants.W_OK | constants.X_OK);
 }
 async checkAccess(signal: AbortSignal) {
  try { this.projectId = await (this.options.checkAccess?.(signal) ?? checkLangfuseAccess(this.config, signal)); }
  catch (error) {
   this.fail("Langfuse project access failed; check credentials, region and network");
   signal.throwIfAborted();
   if (this.options.allowFallback && error instanceof LangfuseAccessError && error.unavailable) return;
   throw new Error("Langfuse project access failed");
  }
 }
 private start(name: string, type: LangfuseObservationType, parent: Handle | undefined, metadata: Record<string, unknown>, attrs: LangfuseObservationAttributes = {}): Handle {
  const merged = sanitize({ ...this.identity, executionId: this.executionId, telemetry_schema_version: 1, ...metadata }, this.secrets) as Record<string, unknown>;
  const attributes = sanitize({ ...attrs, metadata: merged }, this.secrets) as LangfuseObservationAttributes;
  const context = parent ? trace.setSpan(ROOT_CONTEXT, parent.observation.otelSpan) : ROOT_CONTEXT;
  const span = this.runtime.provider.getTracer("langfuse-sdk.auto-smart-lab").startSpan(name, { attributes: {
   ...createObservationAttributes(type, attributes), "langfuse.trace.name": `pipeline:${this.identity.taskId ?? "agent"}`,
   "session.id": this.identity.pipelineRunId ?? this.executionId,
  } }, context);
  const Wrapper = type === "generation" ? LangfuseGeneration : type === "agent" ? LangfuseAgent
   : type === "tool" ? LangfuseTool : type === "chain" ? LangfuseChain : LangfuseSpan;
  const handle: Handle = { observation: type === "event" ? new LangfuseEvent({ otelSpan: span, attributes, timestamp: new Date() })
   : new Wrapper({ otelSpan: span, attributes }), ended: type === "event", metadata: merged };
  if (!handle.ended) this.open.add(handle);
  return handle;
 }
 private update(handle: Handle, attrs: LangfuseObservationAttributes) {
  if (handle.ended) return;
  if (attrs.metadata) handle.metadata = { ...handle.metadata, ...attrs.metadata };
  handle.observation.updateOtelSpanAttributes(sanitize({ ...attrs, metadata: handle.metadata }, this.secrets) as LangfuseObservationAttributes);
  if (attrs.level === "ERROR") handle.observation.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: attrs.statusMessage });
 }
 private end(handle: Handle, attrs: LangfuseObservationAttributes = {}) {
  if (handle.ended) return;
  this.update(handle, attrs); handle.ended = true; this.open.delete(handle); handle.observation.end();
 }
 private stage(identity: TelemetryIdentity) {
  const id = identity.stageInvocationId;
  if (!id) return this.root;
  let stage = this.stages.get(id);
  if (!stage) { stage = this.start(`stage:${identity.stage}`, "span", this.root, { ...identity }); this.stages.set(id, stage); }
  return stage;
 }
 private attempt(identity: TelemetryIdentity) {
  const key = `${identity.stageInvocationId}:${identity.attempt}`;
  let attempt = this.attempts.get(key);
  if (!attempt) { attempt = this.start(`attempt:${identity.attempt ?? 1}`, "agent", this.stage(identity), { ...identity }); this.attempts.set(key, attempt); }
  return attempt;
 }
 private score(owner: Handle, name: string, value: number, dataType: ObservationScore["dataType"], metadata: Record<string, unknown> = {}) {
  const score: ObservationScore = { id: createHash("sha256").update(`${this.traceId}:${owner.observation.id}:${name}:${this.scoreSequence++}`).digest("hex"),
   traceId: this.traceId, observationId: owner.observation.id, name, value, dataType,
   metadata: sanitize({ ...owner.metadata, ...metadata }, this.secrets) as Record<string, unknown> };
  this.journal.write({ version: 1, kind: "score", score });
  if (this.scoreWork.size >= 128) { this.fail("Langfuse score queue limit reached", { kind: "failed_score", score }); return; }
  const send = async () => {
   try {
    if (this.options.sendScore) await this.options.sendScore(score);
    else {
     this.client ??= new LangfuseClient({ ...this.config, timeout: this.config.timeoutMs / 1000 });
     await this.client.api.scores.create({ ...score, environment: this.config.environment }, { maxRetries: 0, timeoutInSeconds: this.config.timeoutMs / 1000 });
    }
   } catch { this.fail("Langfuse score export failed", { kind: "failed_score", score }); }
  };
  const work = send().finally(() => this.scoreWork.delete(work)); this.scoreWork.add(work);
 }
 record(raw: TelemetryRecord) {
  try { this.recordObservation(raw); }
  catch { this.fail("Observation mapping failed; trace coverage is incomplete", { kind: "mapping_failure", eventType: raw.eventType }); }
 }
 private recordObservation(raw: TelemetryRecord) {
  if (this.closed) { this.fail("Observation recorded after telemetry closed"); return; }
  const record = { ...raw, payload: sanitizeEventPayload(raw.eventType, raw.payload, this.secrets) };
  try { this.options.onRecord?.(record); }
  catch { this.fail("Observation callback failed; trace coverage is incomplete"); }
  const type = record.eventType;
  const payload = (record.payload ?? {}) as Record<string, any>;
  const identity = { ...this.identity, ...record.identity };
  const sessionKey = record.agentRunId;
  const parent = this.sessions.get(sessionKey) ?? this.stage(identity);
  const metadata = { ...identity, agentRunId: record.agentRunId, piSessionId: record.piSessionId, eventType: type, sequence: record.sequence, observedAt: record.observedAt };
  if (!["message_update", "tool_execution_update"].includes(type)) {
   this.journal.write({ version: 1, kind: "event", traceId: this.traceId, executionId: this.executionId, ...record });
   if (this.echo) console.log(JSON.stringify(record));
  }
  if (type === "pipeline_run_start") { this.update(this.root, { input: payload, metadata: { previousTraceId: payload.previousTraceId ?? null } }); return; }
  if (type === "pipeline_run_end") {
   this.update(this.root, { output: payload, metadata: { outcome: payload.outcome }, level: payload.outcome === "failure" ? "ERROR" : "DEFAULT" }); return;
  }
  if (type === "stage_started") { this.update(this.stage(identity), { input: payload }); return; }
  if (type === "stage_finished") {
   const stage = this.stage(identity);
   if (typeof payload.validation?.valid === "boolean") this.score(stage, "artifact_valid", +payload.validation.valid, "BOOLEAN", { final: true });
   this.end(stage, { output: payload, metadata: { outcome: payload.outcome }, level: payload.outcome === "failure" ? "ERROR" : "DEFAULT" }); return;
  }
  const setupKey = identity.stageInvocationId ?? "pipeline";
  if (type === "setup_started") {
   this.setups.set(setupKey, this.start("setup", "span", parent, metadata, { input: payload })); return;
  }
  if (type === "setup_check") {
   const event = this.start(type, "event", this.setups.get(setupKey) ?? parent, metadata, { output: payload, level: payload.status === "failed" ? "ERROR" : "DEFAULT" }); this.end(event); return;
  }
  if (type === "setup_finished") {
   const setup = this.setups.get(setupKey);
   if (setup) { this.end(setup, { output: payload, level: payload.valid ? "DEFAULT" : "ERROR" }); this.setups.delete(setupKey); } return;
  }
  if (type === "agent_attempt_start") { this.attempt({ ...identity, attempt: payload.attempt ?? identity.attempt }); return; }
  if (type === "agent_attempt_end") {
   const owner = this.attempts.get(`${identity.stageInvocationId}:${payload.attempt ?? identity.attempt}`);
   if (owner) this.end(owner, { output: payload, level: payload.failed ? "ERROR" : "DEFAULT" }); return;
  }
  if (type === "agent_run_start") {
   const owner = this.start("pi-session", "agent", this.sessions.get(payload.parentAgentRunId) ?? this.attempt(identity), metadata, { input: payload });
   this.sessions.set(sessionKey, owner); return;
  }
  if (type === "agent_run_end") {
   const generation = this.generations.get(sessionKey);
   if (generation) { this.end(generation, { level: "WARNING", statusMessage: "Session closed before model completion" }); this.generations.delete(sessionKey); }
   for (const [id, tool] of this.tools) if (id.startsWith(`${sessionKey}:`)) { this.end(tool, { level: "WARNING", statusMessage: "Session closed before tool completion" }); this.tools.delete(id); }
   this.end(parent, { output: payload }); return;
  }
  if (type === "message_start" && payload.message?.role === "assistant") {
   if (!this.generations.has(sessionKey)) this.generations.set(sessionKey, this.start("model-request", "generation", parent, metadata, { metadata: { request_available: false } }));
   return;
  }
  if (type === "model_request") {
   let generation = this.generations.get(sessionKey);
   if (generation?.metadata.request_available) { this.end(generation, { level: "WARNING", statusMessage: "Model request retried" }); generation = undefined; }
   generation ??= this.start("model-request", "generation", parent, metadata);
   this.generations.set(sessionKey, generation);
   this.update(generation, { input: payload.request, model: payload.model, metadata: { request_available: true, provider: payload.provider } }); return;
  }
  if (type === "message_update") {
   const generation = this.generations.get(sessionKey);
   if (generation && !generation.metadata.completion_started) this.update(generation, { completionStartTime: new Date(record.observedAt), metadata: { completion_started: true } });
   return;
  }
  if (type === "message_end" && payload.message?.role === "assistant") {
   const generation = this.generations.get(sessionKey);
   if (generation) {
    const message = payload.message;
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    this.end(generation, { output: message.content, model: message.model, ...piUsage(message.usage),
     level: failed ? "ERROR" : "DEFAULT", statusMessage: failed ? "Model request failed or aborted" : undefined,
     metadata: { ...piUsage(message.usage).metadata, stop_reason: message.stopReason, provider: message.provider } });
    this.generations.delete(sessionKey);
   }
   return;
  }
  if (type === "tool_execution_start") {
   const key = `${sessionKey}:${payload.toolCallId}`;
   if (!this.tools.has(key)) this.tools.set(key, this.start(payload.toolName, "tool", parent, { ...metadata, toolCallId: payload.toolCallId }, { input: payload.args }));
   return;
  }
  if (type === "tool_execution_update") return;
  if (type === "tool_execution_end") {
   const key = `${sessionKey}:${payload.toolCallId}`, tool = this.tools.get(key);
   if (tool) { this.end(tool, { output: payload.result, level: payload.isError ? "ERROR" : "DEFAULT" }); this.tools.delete(key); }
   return;
  }
  const trialKey = payload.experiment_id ? `${identity.stageInvocationId}:${payload.experiment_id}` : undefined;
  if ((type === "experiment_started" || type === "experiment_reattached") && trialKey) {
   if (!this.trials.has(trialKey)) this.trials.set(trialKey, this.start("harness-trial", "span", this.stage(identity), { ...metadata, experimentId: payload.experiment_id }, { input: payload })); return;
  }
  if (type === "experiment_finished" && trialKey) {
   const owner = this.trials.get(trialKey);
   if (owner) this.end(owner, { output: payload, level: payload.exit_code === 0 ? "DEFAULT" : "ERROR" }); return;
  }
  const owner = trialKey && this.trials.get(trialKey) || parent;
  if (type === "training_trial_result") {
   for (const name of ["balancedAccuracy", "adjustedRandIndex", "selectionScore"]) {
    const value = payload.metrics?.[name];
    if (typeof value === "number" && Number.isFinite(value)) this.score(owner, name, value, "NUMERIC", {
     source: "harness", status: payload.status, datasetSha256: payload.dataset_sha256,
     sampleManifestSha256: payload.sample_manifest_sha256, foldManifestSha256: payload.fold_manifest_sha256,
     selection: payload.selection, sourceCommit: payload.commit,
    });
   }
  }
  if (type === "stage_summary" && typeof payload.readiness_score === "number") this.score(owner, "evaluation_readiness", payload.readiness_score, "NUMERIC", { advisory: true });
  if (type === "artifact_validation" && typeof payload.valid === "boolean") this.score(owner, "artifact_valid", +payload.valid, "BOOLEAN", { final: false, eventSequence: record.sequence });
  const event = this.start(type, "event", owner, metadata, { output: payload,
   level: /error|rejected|refused|failed/.test(type) ? "ERROR" : "DEFAULT" }); this.end(event);
 }
 close(): Promise<void> {
  return this.closing ??= (async () => {
   this.closed = true;
   // The insertion order is parent before child. Reverse it for incomplete scopes.
   for (const handle of [...this.open].reverse()) {
    try { this.end(handle, handle === this.root ? {} : { level: "WARNING", statusMessage: "Scope closed without a terminal lifecycle event" }); }
    catch { this.fail("Observation completion failed; trace coverage is incomplete"); }
   }
   await Promise.all([...this.scoreWork]);
   await this.runtime.release(this);
  })();
 }
}
