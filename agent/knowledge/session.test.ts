import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSubagents } from "../subagents/index.js";
import type { EventRecord, EventSink } from "../observability.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { TaskKnowledge, selectedKnowledge } from "./service.js";
import type { KnowledgeDraft } from "./store.js";

const draft: KnowledgeDraft = { title: "Duplicate audit", summary: "Near duplicates merit a grouping audit", body: "Inspection found an unresolved duplication concern; compare groups before choosing folds.", tags: ["duplicates"], status: "observation", applicability: "This development cohort", caveats: "No measured model comparison" };

test("diagnostic child uses selected knowledge tools, preserves notes and ownership across handoff and follow-up, and excludes ambient files", async () => {
 const root = mkdtempSync(join(tmpdir(), "knowledge-session-")); const agentDir = join(root, "agent"); mkdirSync(agentDir);
 const marker = "AMBIENT_DEVELOPMENT_AND_SKILL_MARKER";
 writeFileSync(join(root, "AGENTS.md"), marker); writeFileSync(join(root, "CLAUDE.md"), marker);
 mkdirSync(join(agentDir, "skills", "ambient"), { recursive: true });
 writeFileSync(join(agentDir, "skills", "ambient", "SKILL.md"), `---\nname: ambient\ndescription: ${marker}\n---\n${marker}`);
 const events: EventRecord[] = [];
 const sink: EventSink = { databaseConnected: false, failures: [], record: e => events.push(e), async close() {} };
 const faux = fauxProvider({ provider: "knowledge-fixture", tokensPerSecond: 1000000, tokenSize: { min: 600000, max: 600000 } });
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false }); runtime.registerNativeProvider(faux.provider);
 const prompts = loadPromptSnapshot();
 const knowledge = { root: join(root, "knowledge"), origin: { taskId: "fixture", datasetSha256: "a".repeat(64), pipelineRunId: "pipeline", stageInvocationId: "invocation" } };
 const originalKnowledge = { ...knowledge, origin: { ...knowledge.origin } };
 const service = new TaskKnowledge(knowledge);
 const prior = await service.capture(draft);
 let contexts = 0;
 const inspect = (context: any) => {
  contexts++;
  const assembled = JSON.stringify(context); expect(assembled).not.toContain(marker);
  expect(assembled).toContain("Search `knowledge_search`");
  expect(context.tools.some((tool: any) => tool.name === "knowledge_read")).toBe(true);
  expect(context.tools.some((tool: any) => tool.name === "knowledge_capture")).toBe(true);
 };
 faux.setResponses([
  context => { inspect(context); return fauxAssistantMessage(fauxToolCall("knowledge_search", { query: "duplicates" }), { stopReason: "toolUse" }); },
  fauxAssistantMessage("work ".repeat(110000)),
  context => { expect(context.tools?.length ?? 0).toBe(0); return fauxAssistantMessage("Continue the duplicate audit using the durable note ID."); },
  context => { inspect(context); return fauxAssistantMessage(fauxToolCall("knowledge_read", { id: prior.id }), { stopReason: "toolUse" }); },
  context => { expect(JSON.stringify(context.messages)).toContain("agent_assertion"); return fauxAssistantMessage("The note is a scoped observation. Further evidence is needed."); },
  context => { inspect(context); return fauxAssistantMessage(fauxToolCall("knowledge_capture", { draft: { ...draft, caveats: "Follow-up inspection still lacks measured model comparison" }, update: { id: prior.id, expectedRevision: 1 } }), { stopReason: "toolUse" }); },
  fauxAssistantMessage("Updated applicability caveat without claiming a measured score."),
 ]);
 const scope = createSubagents({ cwd: root, agentDir, model: faux.getModel(), modelRuntime: runtime, prompts,
  sharedInstructions: [], tools: [], knowledge, env: {}, inputs: [], parentAgentRunId: "parent",
  observe: { identity: { pipelineRunId: "pipeline", stageInvocationId: "invocation", stage: "evaluate", attempt: 1 }, sink } });
 knowledge.origin.taskId = "mutated-after-factory";
 try {
  const child = scope.manager.spawn("Inspect duplicate validation risks and use prior task knowledge", "spawn-knowledge");
  const result = await scope.manager.wait(child.logicalAgentId);
  if (result.status === "failed") throw new Error(JSON.stringify({ result, usage: events.filter(e => e.eventType === "context_usage").map(e => e.payload) }));
  expect(result.status).toBe("idle"); expect(result.output).toContain("Further evidence");
  scope.manager.followup(child.logicalAgentId, "Record the narrower caveat", "knowledge-followup");
  const followup = await scope.manager.wait(child.logicalAgentId); expect(followup.status).toBe("idle");
  const read: any = await new TaskKnowledge(originalKnowledge).read(prior.id); expect(read.revision).toBe(2);
  expect(read.author.taskId).toBe("fixture");
  expect(read.author.logicalAgentId).toBe(child.logicalAgentId); expect(read.author.agentRunId).toBe(followup.agentRunId);
  const starts = events.filter(e => e.eventType === "agent_run_start"); expect(starts).toHaveLength(2);
  const snapshots = events.filter(e => e.eventType === "skill_snapshot"); expect(snapshots).toHaveLength(2);
  for (const snapshot of snapshots) expect((snapshot.payload as any).skills).toEqual(selectedKnowledge(prompts).map(s => s.reference));
  expect(events.some(e => e.eventType === "knowledge_read")).toBe(true); expect(events.some(e => e.eventType === "knowledge_capture")).toBe(true);
  expect(events.every(e => e.identity?.pipelineRunId === "pipeline" && e.identity?.stageInvocationId === "invocation")).toBe(true);
  expect(contexts).toBe(3);
 } finally { await scope.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
