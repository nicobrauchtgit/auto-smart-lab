/** Explicit tiny Cloud write/readback check. No model request or training fit. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LangfuseClient } from "@langfuse/client";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { observeAgentSession } from "../observability.js";
import { runPipeline } from "../pipeline/executor.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import { telemetryConfig } from "./config.js";

export async function smoke() {
 const root = mkdtempSync(join(tmpdir(), "langfuse-smoke-")), configPath = join(root, "config.json");
 const previous = STAGE_REGISTRY.research;
 writeFileSync(configPath, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "unused/model",
  pipeline: { version: 1, entryStage: "research", scheduling: "configured", stages: { research: { enabled: true } }, tasks: { "langfuse-smoke": spamConfiguration() } } }));
 STAGE_REGISTRY.research = {
  name: "research", version: 1, description: "Synthetic Cloud telemetry smoke; no model or fit", parseOptions: () => ({}), checkInput() {},
  async run(context) {
   context.report.input({ kind: "smoke_fixture", version: 1, status: "available", delivery: "none" });
   context.report.event("agent_attempt_start", { attempt: 1 });
   const session = { sessionId: "synthetic-smoke", agent: {}, subscribe() { return () => {}; } } as unknown as AgentSession;
   const observer = await observeAgentSession({ session, model: "synthetic-model", ...context.report.observation(1) });
   try {
    observer.record("prompt_snapshot", { prompts: [{ id: "telemetry.synthetic", template_sha256: "synthetic", rendered_sha256: "synthetic" }] });
    observer.record("message_start", { message: { role: "assistant" } });
    await session.agent.onPayload!({ messages: [{ role: "user", content: "Synthetic telemetry check" }] }, { id: "synthetic-model", provider: "synthetic" } as any);
    observer.record("message_end", { message: { role: "assistant", model: "synthetic-model", provider: "synthetic", content: [{ type: "text", text: "Synthetic response" }], stopReason: "stop",
     usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    observer.record("tool_execution_start", { toolCallId: "synthetic-tool", toolName: "synthetic-tool", args: {} });
    observer.record("tool_execution_end", { toolCallId: "synthetic-tool", toolName: "synthetic-tool", result: { verified: true }, isError: false });
   } finally { await observer.close(); }
   context.report.event("agent_attempt_end", { attempt: 1 });
   context.report.event("artifact_validation", { valid: true, errors: [] });
   return { artifacts: [], validation: { valid: true, errors: [] }, attempts: 1 };
  },
 };
 try {
  const result = await runPipeline({ taskId: "langfuse-smoke", configPath, runsDir: resolve("runs"), invokedBy: { kind: "telemetry_smoke", synthetic: true } });
  console.log(JSON.stringify({ phase: "export", pipelineRunId: result.pipelineRunId, traceId: result.traceId, traceUrl: result.traceUrl, degraded: result.traceDegraded, emergencyPath: result.localTracePath }));
  if (result.traceDegraded || result.outcome !== "success") throw new Error("Synthetic Cloud export failed");
  const client = new LangfuseClient(telemetryConfig());
  for (let attempt = 0; attempt < 12; attempt++) {
   const observations = await client.api.observations.getMany({ traceId: result.traceId, fields: "basic,usage,metadata,io", limit: 100 }, { maxRetries: 0, timeoutInSeconds: 5 });
   const scores = await client.api.scoresV3.getManyV3({ traceId: result.traceId, fields: "subject", limit: 20 }, { maxRetries: 0, timeoutInSeconds: 5 });
   const generation = observations.data.find(observation => observation.type === "GENERATION");
   const tool = observations.data.find(observation => observation.type === "TOOL");
   const stage = observations.data.find(observation => observation.name === "stage:research");
   const physicalSession = observations.data.find(observation => observation.name === "pi-session");
   if (generation && tool && stage && physicalSession && scores.data.some(score => score.name === "artifact_valid")) {
    if (generation.parentObservationId !== physicalSession.id || tool.parentObservationId !== physicalSession.id || generation.usageDetails?.total !== 3)
     throw new Error("Cloud hierarchy or usage did not match the fixture");
    console.log(JSON.stringify({ phase: "readback", observations: observations.data.length, scores: scores.data.length, hierarchyVerified: true, tokenTotal: generation.usageDetails.total, traceUrl: result.traceUrl }));
    return result;
   }
   await Bun.sleep(2000);
  }
  throw new Error("Cloud ingestion did not become readable within the smoke-check window");
 } finally { STAGE_REGISTRY.research = previous; rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) smoke().catch(() => { console.error("Langfuse synthetic smoke failed; no model or training process was started"); process.exitCode = 1; });
