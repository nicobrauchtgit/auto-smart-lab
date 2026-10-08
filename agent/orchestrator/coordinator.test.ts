import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, StateStore, hash, type RunState, type Work } from "./state.js";
import { Coordinator, boundedSummary } from "./coordinator.js";
import { loadPromptSnapshot, restorePromptSnapshot } from "../prompts/loader.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { startStageInvocation, type StageInvocationHandle } from "../pipeline/executor.js";
import { runDecisionAgent, orchestrationSessionOptions } from "./session.js";
import type { StageInput, StageInvocation, StageName } from "../pipeline/types.js";
import { parseOrchestrateArgs } from "../orchestrate_cli.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
function fixture(authorized = true, caps: Partial<RunState["limits"]> = {}) {
 const directory = mkdtempSync(join(tmpdir(), "orchestrator-")), prompts = loadPromptSnapshot();
 const config = resolvePipelineSettings({ defaultModel: "fixture/model", providers: {}, agent: { cwd: directory, agentDir: directory, initialPrompt: "" }, pipeline: { version: 1, scheduling: "agent", entryStage: "research", stages: Object.fromEntries(["research", "solve", "evaluate", "refit", "submit"].map(name => [name, { enabled: true, options: {} }])) } } as any);
 const state = initialState({ taskId: "fixture", taskFingerprint: "a".repeat(64), config, promptTemplates: prompts.serialize(), promptFingerprint: prompts.fingerprint, authorized, limits: caps });
 const store = new StateStore(directory, state);
 // Every scenario starts after the controller declared the task's harness parts.
 new Coordinator(store, { start: () => { throw new Error("unused"); } }).configure({ actionId: "configure", expectedRevision: 0, rationale: "Binary text task", configuration: TASK_CONFIGURATION });
 return { directory, state: store.state, store, prompts, config };
}
const TASK_CONFIGURATION = spamConfiguration();
function fakeResult(work: Work, extra: Partial<StageInvocation> = {}): StageInvocation { return { stage: work.stage, invocationId: work.id, stageVersion: 1, options: {}, startedAt: "now", finishedAt: "now", outcome: "success", artifacts: [], validation: { valid: true, errors: [] }, attempts: 0, ...extra }; }
function controllable(work: Work) {
 let resolve!: (v: StageInvocation) => void;
 const result = new Promise<StageInvocation>(r => { resolve = r; });
 const feedback: unknown[] = [];
 const handle: StageInvocationHandle = { invocationId: work.id, result, state: () => "active", cancel: () => resolve(fakeResult(work, { outcome: "cancelled" })), feedback: async note => { feedback.push(note); return { id: note.id, state: "queued" } as any; } };
 return { handle, resolve, feedback };
}
function request(c: Coordinator, stage: StageName, id: string, artifactIds: string[] = []) { return { stage, actionId: id, expectedRevision: c.state.revision, rationale: "Use validated evidence to investigate the next candidate", objective: "Measured task improvement", artifactIds }; }

test("durable action IDs reject conflicts/stale revisions and serialize mutating work", async () => {
 const f = fixture(); let child!: ReturnType<typeof controllable>; let launches = 0;
 const c = new Coordinator(f.store, { start: work => { launches++; child = controllable(work); return child.handle; } });
 const action = request(c, "research", "baseline"); const first = c.start(action);
 expect(c.start(action).invocationId).toBe(first.invocationId); expect(launches).toBe(1);
 expect(() => c.start({ ...action, objective: "changed" })).toThrow("Action ID conflict");
 expect(() => c.start({ ...request(c, "solve", "stale"), expectedRevision: 0 })).toThrow("Stale revision");
 expect(() => c.start(request(c, "solve", "parallel"))).toThrow("One mutating");
 const note = { actionId: "feedback", expectedRevision: c.state.revision, rationale: "new evidence", invocationId: first.invocationId as string, message: "Inspect observed shift", evidenceIds: [] };
 await c.feedback(note); await c.feedback(note); expect(child.feedback.length).toBe(1);
 expect(child.feedback[0]).toMatchObject({ content: "Inspect observed shift", author: { logicalSessionId: c.state.controlInvocationId } });
 const cancel = { actionId: "cancel", expectedRevision: c.state.revision, rationale: "stop wasted work", invocationId: first.invocationId as string };
 c.cancel(cancel); await c.settle(); expect(c.stageStatus(first.invocationId as string).status).toBe("terminal");
 expect(c.state.actions.length).toBe(4); c.close();
 const reopened = new StateStore(f.directory); expect(reopened.state.counters.stages).toBe(1); expect(reopened.state.journal.length).toBe(reopened.state.revision); reopened.close();
});

test("stages wait for a declared task configuration that matches the task data", () => {
 const directory = mkdtempSync(join(tmpdir(), "orchestrator-unconfigured-")), prompts = loadPromptSnapshot();
 const config = resolvePipelineSettings({ defaultModel: "fixture/model", providers: {}, agent: { cwd: directory, agentDir: directory, initialPrompt: "" }, pipeline: { version: 1, scheduling: "agent", entryStage: "research", stages: { research: { enabled: true, options: {} }, solve: { enabled: true, options: {} } } } } as any);
 const store = new StateStore(directory, initialState({ taskId: "fixture", taskFingerprint: "a".repeat(64), config, promptTemplates: prompts.serialize(), promptFingerprint: prompts.fingerprint, authorized: false }));
 const inputs: StageInput[] = [];
 const c = new Coordinator(store, { suggestedConfiguration: TASK_CONFIGURATION,
  start: (work, input) => { inputs.push(input); return controllable(work).handle; },
  inspectTaskData: configuration => { if (configuration.samples.train !== "spam1-train.zip") throw new Error("Declared task file is missing: other.zip"); return { trainRows: 10, testRows: 5 }; } });
 const status = c.status() as any;
 expect(status.taskConfiguration).toMatchObject({ declared: false, suggested: TASK_CONFIGURATION });
 expect(() => c.start(request(c, "research", "too-early"))).toThrow("Declare the task configuration");
 const mutation = (actionId: string, configuration: unknown) => ({ actionId, expectedRevision: c.state.revision, rationale: "Map the task", configuration });
 // Inconsistent combinations and files that do not match are rejected before anything is recorded.
 expect(() => c.configure(mutation("inconsistent", { ...TASK_CONFIGURATION, metric: "adjusted_rand_index" }))).toThrow("binary_classification is scored with balanced_accuracy");
 expect(() => c.configure(mutation("missing-file", { ...TASK_CONFIGURATION, samples: { ...TASK_CONFIGURATION.samples, train: "other.zip" } }))).toThrow("other.zip");
 expect(c.state.taskConfiguration).toBeUndefined();
 const receipt = c.configure(mutation("declare", TASK_CONFIGURATION)) as any;
 expect(receipt).toMatchObject({ accepted: true, data: { trainRows: 10, testRows: 5 } });
 expect((c.status() as any).taskConfiguration).toMatchObject({ declared: true, sha256: receipt.sha256 });
 c.start(request(c, "research", "research"));
 expect(inputs[0].taskConfiguration).toEqual(TASK_CONFIGURATION);
 expect(c.state.works[0].taskConfiguration).toEqual(TASK_CONFIGURATION);
 // A live invocation keeps the configuration it started with.
 expect(() => c.configure(mutation("redeclare", TASK_CONFIGURATION))).toThrow("Settle or cancel owned work");
 c.close();
 // The declaration survives a restart with its owning action.
 const reopened = new StateStore(directory); expect(reopened.state.taskConfiguration?.sha256).toBe(receipt.sha256); reopened.close();
});

test("faux model chooses measured baseline then official feedback improvements through three-attempt cap", async () => {
 await scenario([0.52, 0.71, 0.68], { expectedSubmissions: 3, expectedSolves: 3, best: 0.71 });
});
test("target score one stops after first official result", async () => { await scenario([1], { expectedSubmissions: 1, expectedSolves: 1, best: 1 }); });
test("preexisting two official attempts leave one autonomous try", async () => { await scenario([0.81], { consumed: 2, expectedSubmissions: 1, expectedSolves: 1, best: 0.81 }); });
test("no-submit chooses local validated artifacts with zero upload calls", async () => { await scenario([], { authorized: false, expectedSubmissions: 0, expectedSolves: 1 }); });
async function scenario(scores: number[], expected: { authorized?: boolean; consumed?: number; expectedSubmissions: number; expectedSolves: number; best?: number }) {
 const f = fixture(expected.authorized ?? true), original = { ...STAGE_REGISTRY };
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory });
 let uploads = 0, solves = 0, reviews = 0, freezes = 0, receivedGoal: any;
 const stages: StageName[] = ["research", "solve", "evaluate", "refit", "submit"];
 for (const name of stages) STAGE_REGISTRY[name] = { name, version: 1, description: name, parseOptions: raw => raw ?? {}, checkInput() {}, async run(context) {
  const artifactKinds = { research: "research_document", solve: "training_selected_result", evaluate: "evaluation_report", refit: "terminal_refit_result", submit: "submission_receipt" };
  if (name === "solve") { solves++; expect(context.input.guidance?.content).toContain(solves > 1 ? "official feedback" : "baseline"); }
  if (name === "evaluate") reviews++; if (name === "refit") freezes++;
  const id = context.report.agentIdentity(1).stageInvocationId!, path = join(f.directory, `${name}-${id}.json`);
  let summary: Record<string, unknown> = { developmentMetric: 0.60 + solves * 0.05, official: false };
  if (name === "submit") {
   expect(context.input.submissionPolicy?.authorized).toBe(true); expect(context.input.submissionPolicy?.controllerInvocationId).toBe(id);
   const score = scores[uploads++]; summary = { state: "scored", officialScore: score, triesUsed: (expected.consumed ?? 0) + uploads, attemptId: String((expected.consumed ?? 0) + uploads), bundleId: `candidate-${solves}` };
  }
  const contents = JSON.stringify({ ...summary, candidate: solves }); writeFileSync(path, contents);
  return { artifacts: [{ kind: artifactKinds[name], path, sha256: hash(contents) }], validation: { valid: true, errors: [] }, summary };
 } };
 let c!: Coordinator;
 c = new Coordinator(f.store, { start: (work, input) => startStageInvocation({ invocationId: work.id, stage: work.stage, input, config: f.config, trace, prompts: f.prompts, reason: "orchestrator_decision", optionOverrides: work.options }), officialStatus: async () => ({ triesUsed: (expected.consumed ?? 0) + uploads }) });
 try {
  await c.refreshOfficial();
  const report = trace.stage("orchestrator", f.state.controlInvocationId);
  await runDecisionAgent({ coordinator: c, prompts: f.prompts, report, taskDescription: "fixture goal", signal: new AbortController().signal, attempt: 1 }, async options => {
   expect(options.tools).toEqual([]); expect(options.extensions).toBe(false); expect(options.extensionPaths).toEqual([]); expect(options.knowledge).toBeUndefined();
   receivedGoal = JSON.parse(options.prompt.split("\n").filter(line => line.startsWith('{')).at(-1)!);
   const call = async (name: string, args: any) => { c.executionGuard.beforeModelRequest(); c.executionGuard.beforeToolCall(); const result = await options.customTools!.find(t => t.name === name)!.execute(`tool-${name}`, args, new AbortController().signal); return JSON.parse((result.content[0] as any).text); };
   const read = () => call("pipeline_status", {});
   const start = async (stage: StageName, guidance?: string) => {
    const state = await read(); const choose = (kind: string) => state.artifacts.filter((a: any) => a.kind === kind).at(-1)?.id;
    const upstream = stage === "research" ? [] : stage === "solve" ? [choose("research_document")] : stage === "evaluate" ? [choose("training_selected_result")] : stage === "refit" ? [choose("training_selected_result"), choose("evaluation_report")] : [choose("terminal_refit_result")];
    const result = await call("stage_start", { ...request(c, stage, `model-${stage}-${c.state.counters.stages}`, upstream), guidance }); expect(result.rejected).not.toBe(true);
    await call("pipeline_wait", { cursor: state.cursor, timeoutMs: 1000 }); await c.settle();
   };
   await start("research", "Establish baseline input knowledge");
   do {
    const state = await read();
    await start("solve", state.officialResults.length ? `Investigate improvements from official feedback ${JSON.stringify(state.officialResults)}` : "Validate baseline pipeline");
    await start("evaluate", "Review measured limitations; advisory only"); await start("refit");
    if (!state.policy.authorized) break;
    await start("submit");
    const after = await read(); if (after.bestOfficial?.score >= after.goal.targetScore || after.budgets.submissionsRemaining === 0) break;
   } while (true);
   await call("pipeline_finish", { actionId: "finish", expectedRevision: c.state.revision, rationale: "Best measured candidate retained with separate official best", outcome: "finished" });
   return { output: "done" };
  });
  expect(receivedGoal.state.goal).toEqual({ objective: "maximize_official_score", targetScore: 1 });
  expect(uploads).toBe(expected.expectedSubmissions); expect(solves).toBe(expected.expectedSolves); expect(reviews).toBe(solves); expect(freezes).toBe(solves);
  expect(c.state.bestOfficial?.score).toBe(expected.best);
  expect(c.state.status).toBe("finished"); expect(c.state.counters.trials).toBe(solves * 6);
  expect(c.state.actions.filter(a => a.kind === "stage_start").length).toBe(1 + solves * 3 + uploads);
 } finally { Object.assign(STAGE_REGISTRY, original); c.close(); await trace.close(); }
}

test("disabled policy and already-used attempts reject submission before dispatch", async () => {
 for (const [authorized, triesUsed] of [[false, 0], [true, 3]] as const) {
  const f = fixture(authorized); let effects = 0;
  const c = new Coordinator(f.store, { start() { effects++; throw new Error("not reached"); }, officialStatus: async () => ({ triesUsed }) });
  await c.refreshOfficial(); expect(() => c.start(request(c, "submit", "upload"))).toThrow(/not authorized|cap is exhausted/); expect(effects).toBe(0); c.close();
 }
});

test("action dispatch failure is durable, never interpreted as agent success", () => {
 const f = fixture(), c = new Coordinator(f.store, { start() { throw new Error("mock dispatch failure"); } });
 c.start(request(c, "research", "failed")); expect(c.state.works[0].summary).toMatchObject({ outcome: "failure", error: "mock dispatch failure" });
 expect(c.state.inbox[0].kind).toBe("stage_failure"); c.close();
});

test("corrupt state and failed persistence refuse before effects; single writer lock", () => {
 const f = fixture(); expect(() => new StateStore(f.directory)).toThrow("owned by another service");
 let effects = 0; const c = new Coordinator(f.store, { start() { effects++; throw new Error("should not dispatch"); } });
 const original = f.store.transaction.bind(f.store); f.store.transaction = () => { throw new Error("disk failure"); };
 expect(() => c.start(request(c, "research", "disk"))).toThrow("disk failure"); expect(effects).toBe(0);
 f.store.transaction = original; c.close(); const envelope = JSON.parse(readFileSync(f.store.path, "utf8")); envelope.state.policy.maxSubmissions = 99;
 writeFileSync(f.store.path, JSON.stringify(envelope)); expect(() => new StateStore(f.directory)).toThrow("checksum mismatch");
 envelope.sha256 = hash(envelope.state); writeFileSync(f.store.path, JSON.stringify(envelope)); expect(() => new StateStore(f.directory)).toThrow("submission policy");
});

test("restart marks lost model invocation interrupted and preserves finite budgets and cursors", async () => {
 const f = fixture(); let work!: Work;
 const c = new Coordinator(f.store, { start: w => { work = w; return controllable(w).handle; } });
 c.charge("modelRequests"); c.start(request(c, "solve", "active")); c.close();
 const reopened = new StateStore(f.directory), restarted = new Coordinator(reopened, { start() { throw new Error("No model reattach"); } });
 await restarted.recover(); expect(restarted.stageStatus(work.id).status).toBe("interrupted"); expect(restarted.state.counters.modelRequests).toBe(1); expect(restarted.state.counters.trials).toBe(6);
 const status = restarted.status(); expect(status.notifications[0].kind).toBe("stage_interrupted");
 await restarted.wait(status.cursor, 0); expect(restarted.status().notifications).toEqual([]);
 expect(restorePromptSnapshot(restarted.state.promptTemplates).fingerprint).toBe(f.prompts.fingerprint); restarted.close();
});

test("deterministic restart uncertainty blocks new effects without duplicating dispatch", async () => {
 const f = fixture(), c = new Coordinator(f.store, { start: work => controllable(work).handle }); c.start(request(c, "refit", "freeze")); c.close();
 const reopened = new StateStore(f.directory); let launches = 0;
 const restarted = new Coordinator(reopened, { start() { launches++; throw new Error("never"); }, recover: async () => undefined });
 await restarted.recover(); expect(restarted.state.status).toBe("blocked"); expect(restarted.state.works[0].status).toBe("uncertain"); expect(() => restarted.start(request(restarted, "solve", "more"))).toThrow("terminal"); expect(launches).toBe(0); restarted.close();
});

test("physical handoff attaches current controller state and narrow allowlist without new work", async () => {
 const f = fixture(), c = new Coordinator(f.store, { start: work => controllable(work).handle });
 c.start(request(c, "research", "active"));
 const report: any = { input() {}, event() {}, observation: () => ({ identity: {}, sink: {} }) };
 const options = orchestrationSessionOptions({ coordinator: c, prompts: f.prompts, report, taskDescription: "task", signal: new AbortController().signal, attempt: 2 });
 expect(JSON.parse(options.sessionContext!()).controllerState.works[0].status).toBe("active"); expect(c.state.counters.stages).toBe(1);
 expect(options.customTools!.map(t => t.name)).toEqual(["pipeline_status", "task_configure", "stage_start", "stage_status", "stage_feedback", "stage_cancel", "artifact_inspect", "pipeline_wait", "pipeline_finish"]);
 await c.stop("test cancellation"); expect(c.state.works[0].result?.outcome).toBe("cancelled"); expect(c.state.status).toBe("cancelled"); c.close();
});

test("bounded summaries preserve structure and omit row-level labels/predictions", () => {
 const result = boundedSummary({ metrics: { score: 0.8 }, predictions: Array(100).fill(1), labels: [0], modelClaims: "a".repeat(20000) }, 1024);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1200); expect(JSON.stringify(result)).not.toContain('"predictions"'); expect(JSON.stringify(result)).not.toContain('"labels"'); expect(result.truncated).toBe(true);
});

test("finite budgets and CLI reject increases above hard submission cap", () => {
 const f = fixture(true, { maxModelRequests: 1, maxToolCalls: 1, maxTrials: 2 });
 const c = new Coordinator(f.store, { start: work => controllable(work).handle }); c.charge("modelRequests"); expect(() => c.charge("modelRequests")).toThrow("budget exhausted");
 c.start(request(c, "solve", "trial-budget")); expect(c.state.counters.trials).toBe(2); c.close();
 expect(parseOrchestrateArgs(["unit", "1", "task", "1", "--goal", "1", "--no-submit"]).options.noSubmit).toBe(true);
 expect(() => parseOrchestrateArgs(["task", "1", "--max-submissions", "4"])).toThrow();
 expect(() => fixture(true, { maxStages: 1000 })).toThrow("increased persisted budget");
});

test("read-only official refresh upserts pending to scored zero or one and preserves candidate evidence", async () => {
 for (const score of [0, 1]) {
  const f = fixture(); let scored = false;
  const c = new Coordinator(f.store, { start() { throw new Error("No dispatch"); }, officialStatus: async () => ({ triesUsed: 1, results: [{ attemptId: "1", status: scored ? "scored" : "pending", ...(scored ? { score } : {}) }] }) });
  await c.refreshOfficial(); f.store.transaction("provenance", {}, s => { s.official[0].candidateId = "frozen-candidate"; s.official[0].artifactId = "receipt-evidence"; });
  scored = true; await c.refreshOfficial(); expect(c.state.official).toHaveLength(1);
  expect(c.state.bestOfficial).toMatchObject({ score, status: "scored", candidateId: "frozen-candidate", artifactId: "receipt-evidence" }); c.close();
 }
});

test("unknown submission reservations consume reported budget and block another upload", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { start: w => { owned = controllable(w); return owned.handle; } });
 c.start(request(c, "refit", "freeze")); const refit = c.state.works[0]; const path = join(f.directory, "result.json"); writeFileSync(path, "{}");
 const artifact = { kind: "terminal_refit_result", path, sha256: hash("{}"), provenance: { artifactId: "frozen-result", sha256: hash("{}"), taskId: f.state.taskId, pipelineRunId: f.state.runId, invocationId: refit.id } };
 owned.resolve(fakeResult(refit, { artifacts: [artifact] })); await c.settle();
 c.start(request(c, "submit", "first", ["frozen-result"])); const submit = c.state.works.at(-1)!;
 owned.resolve(fakeResult(submit, { outcome: "failure", validation: { valid: false, errors: ["uncertain"] }, summary: { state: "unknown", triesUsed: 0, reservedUnknown: 1, effectiveTriesUsed: 1, newAttempt: true, bundleId: "bundle" } })); await c.settle();
 expect(c.status().budgets).toMatchObject({ triesUsed: 0, reservedUnknown: 1, effectiveTriesUsed: 1, submissionsRemaining: 2 });
 expect(c.state.status).toBe("blocked"); expect(() => c.start(request(c, "submit", "second", ["frozen-result"]))).toThrow(); c.close();
 const reopened = new StateStore(f.directory); expect(reopened.state.reservedUnknown).toBe(1); reopened.close();
});

test("production recovery invokes reconcile with no ledger/source and never upload runner", async () => {
 const { reconcileOwnedInvocation } = await import("./run.js");
 const f = fixture(), original = STAGE_REGISTRY.submit;
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory }); let uploads = 0, reconciles = 0;
 STAGE_REGISTRY.submit = { name: "submit", version: 1, description: "mock ledger", parseOptions: () => ({}), checkInput() {},
  async run() { uploads++; throw new Error("Upload must never run in recovery"); },
  async reconcile() { reconciles++; return { artifacts: [], validation: { valid: false, errors: ["no intent; no POST"] }, summary: { state: "unknown", newAttempt: false } }; },
 };
 try {
  const work: Work = { id: "reserved-submit", actionId: "upload", stage: "submit", objective: "submit", upstream: [], status: "reserved" };
  const result = await reconcileOwnedInvocation(work, { taskId: "fixture", taskConfiguration: TASK_CONFIGURATION, upstream: [], submissionPolicy: { ...f.state.policy, controllerInvocationId: work.id } }, { config: f.config, trace, prompts: f.prompts });
  expect(result?.summary).toMatchObject({ state: "unknown", newAttempt: false }); expect(reconciles).toBe(1); expect(uploads).toBe(0);
  // Removed source/candidate files are irrelevant to the registered GET-only path.
  await reconcileOwnedInvocation(work, { taskId: "fixture", upstream: [], submissionPolicy: { ...f.state.policy, controllerInvocationId: work.id } }, { config: f.config, trace, prompts: f.prompts });
  expect(reconciles).toBe(2); expect(uploads).toBe(0);
 } finally { STAGE_REGISTRY.submit = original; f.store.close(); await trace.close(); }
});

test("production preflight reconciles pending before unrelated model checks and stops exhausted/target runs", async () => {
 const { prepareDecisionLoop } = await import("./run.js");
 for (const early of ["pending", "exhausted", "target"] as const) {
  const f = fixture(); const order: string[] = [];
  const c = new Coordinator(f.store, { start: work => controllable(work).handle, officialStatus: async () => ({ triesUsed: early === "exhausted" ? 3 : 1, results: [{ attemptId: "1", status: early === "pending" ? "pending" : "scored", ...(early === "target" ? { score: 1 } : {}) }] }), recover: async work => { order.push("reconcile"); return fakeResult(work, { outcome: "failure", summary: { state: "pending", reservedUnknown: 0, triesUsed: 1 } }); } });
  if (early === "pending") { c.start(request(c, "refit", "placeholder")); f.store.transaction("simulate-crash-before-submit", {}, s => { s.works[0].stage = "submit"; }); }
  const ready = await prepareDecisionLoop(c, { resume: early === "pending", recoverySetup: async () => { order.push("recovery-setup"); }, allSetup: async () => { order.push("model-preflight"); throw new Error("No modelling required"); } });
  expect(ready).toBe(false); expect(order).toEqual(early === "pending" ? ["recovery-setup", "reconcile"] : ["recovery-setup"]); c.close();
 }
});

test("bounded status retains required stage inputs after many training artifact kinds", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "research", "large-catalog")); const work = c.state.works[0], path = join(f.directory, "artifact.json"); writeFileSync(path, "{}");
 const artifacts = ["research_document", ...Array.from({ length: 30 }, (_, i) => `training_detail_${i}`)].map(kind => ({ kind, path, sha256: hash("{}"), provenance: { artifactId: `${work.id}:${kind}`, taskId: "fixture", pipelineRunId: f.state.runId, invocationId: work.id, sha256: hash("{}") } }));
 owned.resolve(fakeResult(work, { artifacts })); await c.settle();
 expect(c.status().artifacts.some(a => a.kind === "research_document")).toBe(true); expect(c.status().artifacts.length).toBeLessThanOrEqual(16); c.close();
});

test("coordinator recovery reconciles an actual pending submit when its original upstream result was removed", async () => {
 const { reconcileOwnedInvocation } = await import("./run.js");
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const original = STAGE_REGISTRY.submit; const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory });
 const c = new Coordinator(f.store, { start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "refit", "frozen")); const refit = c.state.works[0], path = join(f.directory, "original-refit-result.json"); writeFileSync(path, "{}");
 const artifact = { kind: "terminal_refit_result", path, sha256: hash("{}"), provenance: { artifactId: "real-upstream-reference", taskId: "fixture", pipelineRunId: f.state.runId, invocationId: refit.id, sha256: hash("{}") } };
 owned.resolve(fakeResult(refit, { artifacts: [artifact] })); await c.settle();
 c.start(request(c, "submit", "accepted-before-crash", [artifact.provenance.artifactId])); const submitId = c.state.works.at(-1)!.id;
 rmSync(path); c.close(); let uploads = 0, reconciles = 0;
 STAGE_REGISTRY.submit = { name: "submit", version: 1, description: "durable ledger", parseOptions: () => ({}), checkInput(input) { expect(input.upstream[0].sha256).toBe(hash("{}")); },
  async run() { uploads++; throw new Error("No recovery upload"); }, async reconcile(context) { reconciles++; expect(context.input.submissionPolicy?.controllerInvocationId).toBe(submitId); return { artifacts: [], validation: { valid: false, errors: ["pending"] }, summary: { state: "pending", triesUsed: 1, reservedUnknown: 0, newAttempt: false } }; } };
 const reopened = new StateStore(f.directory), restarted = new Coordinator(reopened, { start() { throw new Error("No model"); }, recover: (work, input) => reconcileOwnedInvocation(work, input, { config: f.config, trace, prompts: f.prompts }) });
 try { await restarted.recover(); expect(reconciles).toBe(1); expect(uploads).toBe(0); expect(restarted.state.status).toBe("blocked"); }
 finally { STAGE_REGISTRY.submit = original; restarted.close(); await trace.close(); }
});

test("a new run reads task-global unresolved reservations before any model or stage effects", async () => {
 const { prepareDecisionLoop } = await import("./run.js");
 const f = fixture(); let effects = 0, modelChecks = 0, unresolved = true;
 const c = new Coordinator(f.store, { start() { effects++; throw new Error("No stages before task-global reconciliation"); }, officialStatus: async () => ({ triesUsed: 0, reservedUnknown: unresolved ? 1 : 0, effectiveTriesUsed: unresolved ? 1 : 0, unresolved, results: [] }) });
 const ready = await prepareDecisionLoop(c, { resume: false, recoverySetup: async () => {}, allSetup: async () => { modelChecks++; } });
 expect(ready).toBe(false); expect(c.state.works).toHaveLength(0); expect(c.state.status).toBe("blocked"); expect(c.status().budgets).toMatchObject({ triesUsed: 0, reservedUnknown: 1, effectiveTriesUsed: 1, submissionsRemaining: 2 }); expect(modelChecks).toBe(0); expect(effects).toBe(0);
 unresolved = false; await c.recover(); expect(c.state.status).toBe("running"); expect(c.state.reservedUnknown).toBe(0); c.close();
});
