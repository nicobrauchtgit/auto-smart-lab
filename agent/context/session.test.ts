import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadChildResources } from "../subagents/pi.js";
import { createSubagents } from "../subagents/index.js";
import { observeAgentSession, type TelemetryRecord, type ObservationTelemetry } from "../observability.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import { SmartContextSession, CONTEXT_HANDOFF_TOKENS, omitEmptyTools } from "./session.js";

const prompts = loadPromptSnapshot();
async function fixture(thresholdTokens = CONTEXT_HANDOFF_TOKENS) {
	const root = mkdtempSync(join(tmpdir(), "smart-context-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	writeFileSync(join(root, "AGENTS.md"), "DEVELOPMENT_CONTEXT_EXCLUDED");
	const provider = fauxProvider({ provider: "context-test", tokensPerSecond: 1_000_000 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(provider.provider);
	const events: TelemetryRecord[] = [];
	const sink: ObservationTelemetry = { failures: [], record: event => events.push(event), async close() {} };
	const observe = { identity: { pipelineRunId: "pipeline", stageInvocationId: "invocation", stage: "solve", attempt: 1 }, telemetry: sink };
	const scope = createSubagents({ cwd: root, agentDir, model: provider.getModel(), modelRuntime: runtime,
		prompts, sharedInstructions: [], env: {}, inputs: [], observe });
	let created = 0;
	let closed = 0;
	const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
	const logical = new SmartContextSession({ prompts, thresholdTokens, create: async () => {
		created++;
		const resources = await loadChildResources({ cwd: root, agentDir, instructions: [prompts.render("research.system", {})] });
		const { session } = await createAgentSession({ cwd: root, agentDir, ...resources,
			model: provider.getModel(), modelRuntime: runtime, tools: ["read"], sessionManager: SessionManager.inMemory(root) });
		sessions.push(session);
		assert.match(session.systemPrompt, /research/i);
		assert.doesNotMatch(session.systemPrompt, /DEVELOPMENT_CONTEXT_EXCLUDED/);
		const observer = await observeAgentSession({ session, model: "context-test/faux", ...observe });
		scope.bindParent(observer.agentRunId);
		return { session, agentRunId: observer.agentRunId, record: observer.record,
			async close() { closed++; await observer.close(); session.dispose(); } };
	} });
	return { root, provider, logical, events, sessions, scope, created: () => created, closed: () => closed,
		async close() { await scope.close(); await logical.close(); rmSync(root, { recursive: true, force: true }); } };
}

const start = () => prompts.render("context.task", { task: "Continue researching the current task." });

for (const threshold of [5_000, 120_000]) test(`${threshold} rollover finishes tools, asks for a tool-free handoff, and resumes the same stage`, async () => {
	const f = await fixture(threshold);
	let oldParent = "";
	try {
		writeFileSync(join(f.root, "evidence.txt"), "verified measurement");
		f.provider.setResponses([
			() => {
				oldParent = f.logical.agentRunId!;
				f.sessions[0].getContextUsage = () => ({ tokens: threshold, contextWindow: 200_000, percent: threshold / 2000 });
				return fauxAssistantMessage(fauxToolCall("read", { path: join(f.root, "evidence.txt") }), { stopReason: "toolUse" });
			},
			context => {
				assert.match(JSON.stringify(context.messages), /verified measurement/);
				assert.match(JSON.stringify(context.messages), /Produce only a concise handoff/);
				assert.equal(context.tools?.length ?? 0, 0);
				void f.logical.steer("experiment abc completed during handoff");
				return fauxAssistantMessage("Read evidence.txt. Next: validate the findings. Experiment abc remains available.");
			},
			context => {
				assert.equal(f.created(), 2);
				assert.notEqual(f.logical.agentRunId, oldParent);
				assert.match(JSON.stringify(context.messages), /Next: validate/);
				assert.match(JSON.stringify(context.messages), /experiment abc completed during handoff/);
				assert.equal(context.messages.some(message => message.role === "toolResult"), false);
				assert.ok(context.tools?.some(tool => tool.name === "read"));
				return fauxAssistantMessage("Research complete; artifacts ready for validation.");
			},
		]);
		assert.equal(await f.logical.prompt(start()), "Research complete; artifacts ready for validation.");
		assert.equal(f.closed(), 1);
		const linked = f.events.find(event => event.eventType === "context_handoff_resumed")!;
		assert.equal((linked.payload as any).previous.agentRunId, oldParent);
		assert.ok(f.events.every(event => event.identity?.stageInvocationId === "invocation"));
		assert.ok(f.events.every(event => event.identity?.attempt === 1));
		assert.equal(f.events.filter(event => event.eventType === "agent_run_start").length, 2);
		assert.equal(f.events.filter(event => event.eventType === "subagent_parent_rebound").length, 1);
		const child = f.scope.manager.spawn("Continue validation", "spawn-after-handoff");
		assert.equal(child.parentAgentRunId, f.logical.agentRunId);
		await f.scope.manager.cancel(child.logicalAgentId);
	} finally { await f.close(); }
});

test("below threshold and unknown usage do not replace sessions; follow-ups retain context", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			() => {
				f.sessions[0].getContextUsage = () => ({ tokens: CONTEXT_HANDOFF_TOKENS - 1, contextWindow: 200_000, percent: 60 });
				return fauxAssistantMessage("First result");
			},
			context => {
				assert.match(JSON.stringify(context.messages), /First result/);
				f.sessions[0].getContextUsage = () => undefined;
				return fauxAssistantMessage("Second result");
			},
		]);
		assert.equal(await f.logical.prompt(start()), "First result");
		assert.equal(await f.logical.prompt(start()), "Second result");
		assert.equal(f.created(), 1);
	} finally { await f.close(); }
});

test("an empty handoff fails without returning the handoff as stage success", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			() => {
				f.sessions[0].getContextUsage = () => ({ tokens: 120_001, contextWindow: 200_000, percent: 60 });
				return fauxAssistantMessage("Progress");
			},
			fauxAssistantMessage("   "),
		]);
		await assert.rejects(f.logical.prompt(start()), /Empty or oversized/);
		assert.equal(f.created(), 1);
		assert.ok(f.events.some(event => event.eventType === "context_session_failed"));
	} finally { await f.close(); }
});

test("cancellation during handoff never launches a replacement", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			() => {
				f.sessions[0].getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
				return fauxAssistantMessage("Progress");
			},
			() => { void f.logical.abort(); return fauxAssistantMessage("Handoff"); },
		]);
		await assert.rejects(f.logical.prompt(start()), /cancelled/);
		assert.equal(f.created(), 1);
	} finally { await f.close(); }
});

test("multiple handoffs link each replacement and never return intermediate summaries", async () => {
	const f = await fixture();
	try {
		const high = () => {
			f.sessions.at(-1)!.getContextUsage = () => ({ tokens: 125_000, contextWindow: 200_000, percent: 62.5 });
			return fauxAssistantMessage("Continue work");
		};
		f.provider.setResponses([high, fauxAssistantMessage("First handoff"), high,
			fauxAssistantMessage("Second handoff"), fauxAssistantMessage("Final result")]);
		assert.equal(await f.logical.prompt(start()), "Final result");
		assert.equal(f.created(), 3);
		const links = f.events.filter(event => event.eventType === "context_handoff_resumed");
		assert.equal(links.length, 2);
		assert.equal((links[1].payload as any).previous.agentRunId, links[0].agentRunId);
	} finally { await f.close(); }
});

test("handoff model failure is surfaced without starting a successor", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			() => {
				f.sessions[0].getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
				f.sessions[0].settingsManager.applyOverrides({ retry: { enabled: false } });
				return fauxAssistantMessage("Progress");
			},
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "handoff failure fixture" }),
		]);
		await assert.rejects(f.logical.prompt(start()), /handoff failure fixture/);
		assert.equal(f.created(), 1);
	} finally { await f.close(); }
});

test("tool-free handoff payload omits unsupported empty tools and tool-only options", () => {
	const payload = { model: "mistral", tools: [], tool_choice: "auto", parallel_tool_calls: false, messages: [] };
	assert.deepEqual(omitEmptyTools(payload), { model: "mistral", messages: [] });
	assert.deepEqual(payload.tools, []);
	const ordinary = { tools: [{ type: "function" }], tool_choice: "auto" };
	assert.equal(omitEmptyTools(ordinary), ordinary);
	assert.equal(omitEmptyTools(undefined), undefined);
});

test("typed feedback crosses repeated handoffs exactly once, coexists with training steering, and refuses idle completion", async () => {
 const f = await fixture(5000); let admitted = 0;
 try {
  const high = () => {
   f.sessions.at(-1)!.getContextUsage = () => ({ tokens: 6000, contextWindow: 200000, percent: 3 });
   return fauxAssistantMessage("Progress");
  };
  f.provider.setResponses([
   high,
   () => { void f.logical.deliverFeedback("stable-feedback", "FACTUAL_FEEDBACK", () => { admitted++; }); return fauxAssistantMessage("First pointer"); },
   context => {
    assert.equal(JSON.stringify(context.messages).match(/FACTUAL_FEEDBACK/g)?.length, 1);
    return high();
   },
   () => { void f.logical.steer("HARNESS_TRAINING_UPDATE"); return fauxAssistantMessage("Second pointer"); },
   context => {
    assert.match(JSON.stringify(context.messages), /HARNESS_TRAINING_UPDATE/);
    f.sessions.at(-1)!.getContextUsage = () => undefined;
    // Consumed feedback is not replayed as a live update on replacement.
    assert.doesNotMatch(JSON.stringify(context.messages), /FACTUAL_FEEDBACK/);
    return fauxAssistantMessage("Final artifacts");
   },
  ]);
  await f.logical.prompt(start());
  assert.equal(admitted, 1);
  assert.equal(await f.logical.deliverFeedback("late", "LATE_FEEDBACK", () => { admitted++; }), false);
  assert.equal(f.created(), 3);
 } finally { await f.close(); }
});

test("feedback queued during final response never starts a new turn and remains unconsumed", async () => {
 const f = await fixture(); let admitted = 0;
 try {
  f.provider.setResponses([() => {
   void f.logical.deliverFeedback("final-race", "FINAL_RACE", () => { admitted++; });
   return fauxAssistantMessage("Done");
  }]);
  assert.equal(await f.logical.prompt(start()), "Done");
  assert.equal(admitted, 0); assert.equal(f.created(), 1);
 } finally { await f.close(); }
});

test("module guidance appears in assembled openings and every replacement while AGENTS marker stays excluded", async () => {
 const { guidanceHash, guidanceBlock } = await import("../pipeline/guidance.js");
 const { prepareResearchPrompts } = await import("../prompts/research.js");
 const { prepareSolvePrompts } = await import("../prompts/solve.js");
 for (const stage of ["research", "solve", "evaluate"] as const) {
  const f = await fixture(5000);
  try {
   const body = { id: "immutable", version: 1, stage, taskId: "fixture", content: "INVOCATION_GUIDANCE {{literal}}", evidence: [] };
   const guidance = { ...body, contentSha256: guidanceHash(body) };
   const opening = stage === "research" ? prepareResearchPrompts(prompts, { taskId: "fixture", contextHash: "context", guidance }).prompt :
    stage === "solve" ? prepareSolvePrompts(prompts, { taskId: "fixture", workspace: "/tmp", datasetPaths: [], configuration: spamConfiguration(), targets: "/tmp/labels", rowCount: 10, targetSummary: "balanced", foldRecommendation: "two", researchState: "prior", maxIterations: 1, guidance }).prompt :
    [prompts.render("review.start", { taskId: "fixture", experimentId: "candidate", code: "{}", evidence: "{}" }).text, guidanceBlock(prompts, guidance)!.text].join("\n\n");
   f.provider.setResponses([
    context => { assert.match(JSON.stringify(context.messages), /INVOCATION_GUIDANCE/); f.sessions[0].getContextUsage = () => ({ tokens: 6000, contextWindow: 200000, percent: 3 }); return fauxAssistantMessage("Progress"); },
    fauxAssistantMessage("Read the current artifact"),
    context => { assert.match(JSON.stringify(context.messages), /INVOCATION_GUIDANCE \{\{literal\}\}/); f.sessions.at(-1)!.getContextUsage = () => undefined; assert.doesNotMatch(context.systemPrompt ?? "", /DEVELOPMENT_CONTEXT_EXCLUDED/); return fauxAssistantMessage("Complete"); },
   ]);
   await f.logical.prompt(prompts.render("context.task", { task: opening }));
   assert.equal(f.created(), 2);
  } finally { await f.close(); }
 }
});

test("feedback is delivered only with the next natural tool continuation and uses IDs rather than text", async () => {
 const f = await fixture(); let admitted = 0;
 const feedbackPrompt = prompts.render("shared.stage-feedback", { note: "SAME_FACT" });
 try {
  writeFileSync(join(f.root, "fixture.txt"), "evidence");
  f.provider.setResponses([
   () => {
    void f.logical.deliverFeedback("one", feedbackPrompt.text, () => { admitted++; }, feedbackPrompt.reference);
    void f.logical.deliverFeedback("two", "SAME_FACT", () => { admitted++; });
    void f.logical.deliverFeedback("one", "SAME_FACT", () => { admitted += 100; });
    return fauxAssistantMessage(fauxToolCall("read", { path: join(f.root, "fixture.txt") }), { stopReason: "toolUse" });
   },
   context => { assert.equal(admitted, 2); assert.equal(JSON.stringify(context.messages).match(/SAME_FACT/g)?.length, 2); return fauxAssistantMessage("Done"); },
  ]);
  await f.logical.prompt(start()); assert.equal(admitted, 2);
  const event = f.events.find(event => event.eventType === "stage_feedback_request" && (event.payload as any).feedbackId === "one");
  assert.deepEqual((event?.payload as any).prompt, feedbackPrompt.reference);
 } finally { await f.close(); }
});

test("cancellation while feedback waits in handoff never delivers it or creates a successor", async () => {
 const f = await fixture(5000); let admitted = 0;
 try {
  f.provider.setResponses([
   () => { f.sessions[0].getContextUsage = () => ({ tokens: 6000, contextWindow: 200000, percent: 3 }); return fauxAssistantMessage("Progress"); },
   () => { void f.logical.deliverFeedback("cancelled", "NEVER_DELIVERED", () => { admitted++; }); void f.logical.abort(); return fauxAssistantMessage("Pointer"); },
  ]);
  await assert.rejects(f.logical.prompt(start()), /cancelled/);
  assert.equal(admitted, 0); assert.equal(f.created(), 1);
 } finally { await f.close(); }
});
