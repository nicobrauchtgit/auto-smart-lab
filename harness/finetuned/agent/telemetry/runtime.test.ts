import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry } from "./runtime.js";
import { testTelemetry } from "./testing.js";
import { agentEnvironment, sanitize } from "./metadata.js";
import { LangfuseAccessError, telemetryConfig } from "./config.js";
import { invokeStage, runPipeline } from "../pipeline/executor.js";
import { observeAgentSession } from "../observability.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createPipelineTrace } from "../pipeline/trace.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "langfuse-test-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function recorder(telemetry: Telemetry, stage = "solve", invocationId = "invocation", session = "agent") {
 let sequence = 0;
 return (eventType: string, payload: any = {}) => telemetry.record({ agentRunId: session, piSessionId: "pi", sequence: sequence++, eventType,
  observedAt: new Date().toISOString(), payload, identity: { stage, stageInvocationId: invocationId, attempt: 1 } });
}
const attr = (span: import("@opentelemetry/sdk-trace-base").ReadableSpan, key: string) => JSON.parse(String(span.attributes[`langfuse.observation.${key}`]));

test("Bun SDK keeps concurrent stages, physical sessions, generations, tools and trials in one explicit hierarchy", async () => {
 const options = testTelemetry(), telemetry = new Telemetry({ pipelineRunId: "run", taskId: "task" }, directory(), options);
 await telemetry.checkAccess(new AbortController().signal);
 const first = recorder(telemetry), second = recorder(telemetry, "research", "other", "other-agent");
 first("stage_started", { options: { mode: "inductive" } }); second("stage_started");
 first("agent_attempt_start", { attempt: 1 }); first("agent_run_start"); second("agent_run_start");
 first("prompt_snapshot", { prompts: [{ id: "solve.system", template_sha256: "hash" }] });
 first("message_start", { message: { role: "assistant" } }); first("model_request", { model: "test-model", provider: "test", request: { messages: [{ role: "user", content: "hello" }] } });
 for (let n = 0; n < 50; n++) first("message_update", { message: { role: "assistant" } });
 first("message_end", { message: { role: "assistant", model: "test-model", stopReason: "toolUse", content: [{ type: "text", text: "done" }],
  usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 2, totalTokens: 19, cost: { input: .01, output: .03, cacheRead: .002, cacheWrite: .003, total: .045 } } } });
 first("tool_execution_start", { toolCallId: "tool", toolName: "training_start", args: { hypothesis: "test" } });
 first("tool_execution_update", { toolCallId: "tool", partialResult: "working" });
 first("experiment_started", { experiment_id: "trial" });
 first("tool_execution_end", { toolCallId: "tool", toolName: "training_start", isError: false, result: { id: "trial" } });
 first("message_end", { message: { role: "toolResult", usage: { input: 999 } } });
 first("training_trial_result", { experiment_id: "trial", metrics: { balancedAccuracy: .75 }, dataset_sha256: "dataset", fold_manifest_sha256: "folds" });
 first("experiment_finished", { experiment_id: "trial", exit_code: 0 });
 first("agent_run_end"); second("agent_run_end"); first("agent_attempt_end", { attempt: 1 });
 first("stage_finished", { outcome: "failure", validation: { valid: false } }); second("stage_finished", { outcome: "success" });
 await telemetry.close(); await telemetry.close();
 const spans = options.exporter.spans;
 expect(new Set(spans.map(span => span.spanContext().traceId))).toEqual(new Set([telemetry.traceId]));
 const generation = spans.filter(span => span.attributes["langfuse.observation.type"] === "generation");
 expect(generation).toHaveLength(1);
 expect(attr(generation[0], "usage_details")).toEqual({ input: 10, output: 3, input_cached: 4, input_cache_creation: 2, total: 19 });
 expect(attr(generation[0], "cost_details").total).toBe(.045);
 expect(attr(generation[0], "input").messages[0].content).toBe("hello");
 const stage = spans.find(span => span.name === "stage:solve")!;
 const session = spans.find(span => span.name === "pi-session" && span.attributes["langfuse.observation.metadata.agentRunId"] === "agent")!;
 expect(generation[0].parentSpanContext?.spanId).toBe(session.spanContext().spanId);
 expect(spans.find(span => span.name === "harness-trial")!.parentSpanContext?.spanId).toBe(stage.spanContext().spanId);
 expect(spans.filter(span => span.attributes["langfuse.observation.type"] === "tool")).toHaveLength(1);
 expect(attr(stage, "output").outcome).toBe("failure");
 expect(options.scores.find(score => score.name === "balancedAccuracy")?.metadata.foldManifestSha256).toBe("folds");
 expect(telemetry.degraded).toBe(false); expect(telemetry.localPath).toBeUndefined();
 expect(existsSync(`${telemetry.artifactRoot}.emergency.jsonl`)).toBe(false);
 expect(telemetry.traceUrl).toContain(`/traces/${telemetry.traceId}`);
});

test("failed export at final flush captures exact sanitized spans and marks execution degraded", async () => {
 const options = testTelemetry(); options.exporter.failed = true;
 const telemetry = new Telemetry({ pipelineRunId: "run" }, directory(), options), record = recorder(telemetry);
 record("stage_started", { secret: "test-secret", text: "test-secret" }); record("artifact_validation", { valid: true });
 expect(telemetry.localPath).toBeUndefined();
 await telemetry.close();
 expect(telemetry.degraded).toBe(true);
 const journal = readFileSync(telemetry.localPath!, "utf8");
 expect(journal).toContain("failed_observation"); expect(journal).toContain("stage:solve");
 expect(journal).not.toContain("test-secret"); expect(journal).not.toContain("Authorization");
});

test("queue overflow writes affected observations without exceeding the bounded SDK queue", async () => {
 const options = { ...testTelemetry(), maxPendingSpans: 1 };
 const telemetry = new Telemetry({}, directory(), options), record = recorder(telemetry);
 record("progress"); record("progress"); record("progress");
 await telemetry.close();
 expect(telemetry.failures).toContain("Langfuse observation queue limit reached");
 expect(readFileSync(telemetry.localPath!, "utf8")).toContain("failed_observation");
});

test("score delivery and emergency-write failures are observable and do not throw into harness cleanup", async () => {
 const options = testTelemetry(); options.sendScore = async () => { throw new Error("provider secret"); };
 const root = directory(); writeFileSync(join(root, "blocked"), "file");
 const telemetry = new Telemetry({ taskId: "task" }, join(root, "blocked"), options), record = recorder(telemetry);
 record("artifact_validation", { valid: true }); await telemetry.close();
 expect(telemetry.failures).toContain("Langfuse score export failed");
 expect(telemetry.failures).toContain("Emergency trace write failed; local trace coverage unavailable");
 expect(telemetry.localPath).toBeUndefined();
});

test("explicit initial fallback permits service outage but never invalid credentials", async () => {
 for (const unavailable of [true, false]) {
  const options = { ...testTelemetry(), allowFallback: true, checkAccess: async () => { throw new LangfuseAccessError(unavailable); } };
  const telemetry = new Telemetry({}, directory(), options);
  if (unavailable) await telemetry.checkAccess(new AbortController().signal);
  else await expect(telemetry.checkAccess(new AbortController().signal)).rejects.toThrow("access failed");
  expect(telemetry.degraded).toBe(true); await telemetry.close();
 }
});

test("invalid Langfuse prerequisites block standalone stage execution before agent construction", async () => {
 const previous = STAGE_REGISTRY.solve;
 const options = testTelemetry(); options.checkAccess = async () => { throw new LangfuseAccessError(false); };
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: "setup-run", runsDir: directory(), telemetry: options });
 let ran = false;
 STAGE_REGISTRY.solve = { name: "solve", version: 1, description: "fixture", parseOptions: () => ({}), checkInput() {}, async run() { ran = true; return { artifacts: [] }; } };
 try {
  const config = resolvePipelineSettings({ pipeline: { entryStage: "solve", stages: { solve: { enabled: true } }, tasks: { fixture: spamConfiguration() } }, agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "unused/model" } as any);
  const result = await invokeStage({ stage: "solve", input: { taskId: "fixture", upstream: [] }, config, trace });
  expect(result.outcome).toBe("failure"); expect(result.error).toContain("langfuse-access"); expect(ran).toBe(false);
 } finally { STAGE_REGISTRY.solve = previous; await trace.close(); }
});

test("configuration rejects missing keys and credential-bearing endpoints; child environments omit Langfuse", () => {
 expect(() => telemetryConfig({ LANGFUSE_PUBLIC_KEY: "" })).toThrow("LANGFUSE_PUBLIC_KEY");
 expect(() => telemetryConfig({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://secret@example.com" })).toThrow("HTTPS origin");
 expect(agentEnvironment({ PATH: "test", LANGFUSE_SECRET_KEY: "secret", LANGFUSE_PUBLIC_KEY: "public" })).toEqual({ PATH: "test" });
 expect(sanitize({ headers: { Authorization: "Basic hidden" }, output: "secret" }, ["secret"])).toEqual({ headers: { Authorization: "[REDACTED]" }, output: "[REDACTED]" });
});

test("final-flush failures reach the pipeline result while authoritative success is preserved", async () => {
 const root = directory(), configPath = join(root, "config.json"), previous = STAGE_REGISTRY.research;
 writeFileSync(configPath, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "unused/model",
  pipeline: { entryStage: "research", stages: { research: { enabled: true } }, tasks: { fixture: spamConfiguration() } } }));
 STAGE_REGISTRY.research = { name: "research", version: 1, description: "fixture", parseOptions: () => ({}), checkInput() {},
  async run() { return { artifacts: [], validation: { valid: true, errors: [] } }; } };
 const options = testTelemetry(); options.exporter.failed = true;
 try {
  const result = await runPipeline({ taskId: "fixture", configPath, runsDir: root, telemetry: options });
  expect(result.outcome).toBe("success"); expect(result.traceDegraded).toBe(true);
  expect(result.traceFailures).toContain("Langfuse observation export failed");
  expect(readFileSync(result.localTracePath!, "utf8")).toContain("pipeline-execution");
 } finally { STAGE_REGISTRY.research = previous; }
});

test("missing Langfuse keys fail local prerequisites before a stage starts", async () => {
 const previous = STAGE_REGISTRY.solve, savedPublic = process.env.LANGFUSE_PUBLIC_KEY, savedSecret = process.env.LANGFUSE_SECRET_KEY;
 delete process.env.LANGFUSE_PUBLIC_KEY; delete process.env.LANGFUSE_SECRET_KEY;
 const options = testTelemetry(); delete options.config;
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: "missing-setup", runsDir: directory(), telemetry: options });
 let ran = false;
 STAGE_REGISTRY.solve = { name: "solve", version: 1, description: "fixture", parseOptions: () => ({}), checkInput() {}, async run() { ran = true; return { artifacts: [] }; } };
 try {
  const config = resolvePipelineSettings({ pipeline: { entryStage: "solve", stages: { solve: { enabled: true } }, tasks: { fixture: spamConfiguration() } }, agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "unused/model" } as any);
  const result = await invokeStage({ stage: "solve", input: { taskId: "fixture", upstream: [] }, config, trace });
  expect(result.error).toContain("langfuse-configuration"); expect(ran).toBe(false);
 } finally {
  STAGE_REGISTRY.solve = previous; await trace.close();
  if (savedPublic === undefined) delete process.env.LANGFUSE_PUBLIC_KEY; else process.env.LANGFUSE_PUBLIC_KEY = savedPublic;
  if (savedSecret === undefined) delete process.env.LANGFUSE_SECRET_KEY; else process.env.LANGFUSE_SECRET_KEY = savedSecret;
 }
});

test("Pi request observation preserves the controller hook and links child and replacement sessions", async () => {
 const options = testTelemetry(), telemetry = new Telemetry({ pipelineRunId: "handoff" }, directory(), options);
 const identity = { stage: "solve", stageInvocationId: "handoff-stage", attempt: 1 };
 let guarded = 0;
 const previous = async (payload: any) => { guarded++; return { ...payload, guarded: true }; };
 const session = { sessionId: "parent", agent: { onPayload: previous }, subscribe() { return () => {}; } } as unknown as AgentSession;
 const first = await observeAgentSession({ session, model: "fixture-model", identity, telemetry });
 await session.agent.onPayload!({ messages: [] }, { id: "fixture-model", provider: "fixture" } as any);
 first.record("message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
 const childSession = { sessionId: "child", agent: {}, subscribe() { return () => {}; } } as unknown as AgentSession;
 const child = await observeAgentSession({ session: childSession, model: "fixture-model", identity, telemetry, parentAgentRunId: first.agentRunId });
 await child.close(); await first.close();
 expect(session.agent.onPayload).toBe(previous); expect(guarded).toBe(1);
 const replacement = await observeAgentSession({ session, model: "fixture-model", identity, telemetry }); await replacement.close();
 await telemetry.close();
 const spans = options.exporter.spans, sessions = spans.filter(span => span.name === "pi-session");
 expect(sessions).toHaveLength(3);
 const parent = sessions.find(span => span.attributes["langfuse.observation.metadata.agentRunId"] === first.agentRunId)!;
 const nested = sessions.find(span => span.attributes["langfuse.observation.metadata.agentRunId"] === child.agentRunId)!;
 const resumed = sessions.find(span => span.attributes["langfuse.observation.metadata.agentRunId"] === replacement.agentRunId)!;
 expect(nested.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
 expect(resumed.parentSpanContext?.spanId).toBe(parent.parentSpanContext?.spanId);
 expect(attr(spans.find(span => span.attributes["langfuse.observation.type"] === "generation")!, "input").guarded).toBe(true);
});

test("validation snapshots and final validation have separate score identities", async () => {
 const options = testTelemetry(), telemetry = new Telemetry({}, directory(), options), record = recorder(telemetry);
 record("artifact_validation", { valid: false }); record("artifact_validation", { valid: true });
 record("stage_finished", { outcome: "success", validation: { valid: true } }); await telemetry.close();
 expect(new Set(options.scores.map(score => score.id)).size).toBe(3);
 expect(options.scores.find(score => score.metadata.final)?.value).toBe(1);
});

test("large model/tool payloads retain lifecycle IDs and terminal usage after IO truncation", async () => {
 const options = testTelemetry(), telemetry = new Telemetry({}, directory(), options), record = recorder(telemetry);
 const large = Array.from({ length: 20 }, () => ({ text: "x".repeat(24000) }));
 record("agent_run_start"); record("message_start", { message: { role: "assistant" } });
 record("model_request", { model: "fixture-model", provider: "fixture", request: { messages: large } });
 record("message_end", { message: { role: "assistant", content: large, stopReason: "stop", usage: { input: 4, output: 2, totalTokens: 6 } } });
 record("tool_execution_start", { toolName: "large-tool", toolCallId: "bounded-tool", args: { data: large } });
 record("tool_execution_end", { toolName: "large-tool", toolCallId: "bounded-tool", result: { data: large }, isError: false });
 record("agent_run_end"); record("stage_finished", { outcome: "success", artifacts: large, validation: { valid: true, errors: [] } }); await telemetry.close();
 const generation = options.exporter.spans.find(span => span.attributes["langfuse.observation.type"] === "generation")!;
 const tool = options.exporter.spans.find(span => span.name === "large-tool")!;
 expect(attr(generation, "usage_details").total).toBe(6);
 expect(attr(generation, "output").truncated).toBe(true);
 expect(tool.attributes["langfuse.observation.metadata.toolCallId"]).toBe("bounded-tool");
 expect(tool.attributes["langfuse.observation.level"]).toBe("DEFAULT");
 expect(options.scores.find(score => score.metadata.final)?.value).toBe(1);
 expect(telemetry.degraded).toBe(false);
});
