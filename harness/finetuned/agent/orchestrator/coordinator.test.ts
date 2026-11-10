import { testTelemetry, traceEvents } from "../telemetry/testing.js";
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
import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
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
 let resolve!: (v: StageInvocation) => void; let reject!: (error: Error) => void;
 const result = new Promise<StageInvocation>((r, j) => { resolve = r; reject = j; });
 const feedback: unknown[] = [];
 const handle: StageInvocationHandle = { invocationId: work.id, result, state: () => "active", cancel: () => resolve(fakeResult(work, { outcome: "cancelled" })), feedback: async note => { feedback.push(note); return { id: note.id, state: "queued" } as any; } };
 return { handle, resolve, reject, feedback };
}
function request(c: Coordinator, stage: StageName, id: string, artifactIds: string[] = []) { return { stage, actionId: id, expectedRevision: c.state.revision, rationale: "Use validated evidence to investigate the next candidate", objective: "Measured task improvement", artifactIds }; }

test("confirmation remains visible to the controller but cannot enter solve inputs or feedback", async () => {
 const f = fixture();
 let child!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { child = controllable(work); return child.handle; } });
 const producer = c.start(request(c, "solve", "champion"));
 const artifacts = Array.from({ length: 20 }, (_, index) => ({ kind: `fold-${index}`, contents: {} }));
 artifacts.push({ kind: "holdout_confirmation", contents: { readCount: 1, populationReadCount: 1 } as any });
 const work = c.state.works.find(w => w.id === producer.invocationId)!;
 const saved = artifacts.map((value, index) => {
  const path = join(f.directory, `evidence-${index}.json`), bytes = JSON.stringify(value.contents); writeFileSync(path, bytes);
  return { kind: value.kind, path, bytes: bytes.length, sha256: hash(bytes), provenance: { artifactId: `artifact-${index}`, taskId: "fixture", pipelineRunId: f.state.runId, invocationId: work.id, sha256: hash(bytes) } };
 });
 child.resolve(fakeResult(work, { artifacts: saved, summary: { holdout_confirmation: { readCount: 1, balancedAccuracy: .8 } } }));
 await c.settle();
 const id = saved.at(-1)!.provenance.artifactId;
 expect((c.status() as any).artifacts.some((a: any) => a.id === id)).toBe(true);
 expect(JSON.stringify(c.inspect(id))).toContain('readCount');
 expect(() => c.start(request(c, "solve", "bad-input", [id]))).toThrow("must not enter solve");
 expect(() => c.start({ ...request(c, "solve", "bad-guidance"), evidenceIds: [id], guidance: "Use confirmation" })).toThrow("must not enter solve");
 const next = c.start(request(c, "solve", "next"));
 await expect(c.feedback({ actionId: "bad-feedback", expectedRevision: c.state.revision, rationale: "holdout", invocationId: next.invocationId as string, message: "Use confirmation", evidenceIds: [id] })).rejects.toThrow("must not enter solve feedback");
 expect(child.feedback).toHaveLength(0);
 c.cancel({ actionId: "stop", expectedRevision: c.state.revision, rationale: "fixture finished", invocationId: next.invocationId as string });
 await c.settle(); c.close();
});

test("durable action IDs reject conflicts/stale revisions and serialize mutating work", async () => {
 const f = fixture(); let child!: ReturnType<typeof controllable>; let launches = 0;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { launches++; child = controllable(work); return child.handle; } });
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
 const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory });
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
 c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: (work, input) => startStageInvocation({ invocationId: work.id, stage: work.stage, input, config: f.config, trace, prompts: f.prompts, reason: "orchestrator_decision", optionOverrides: work.options }), officialStatus: async () => ({ triesUsed: (expected.consumed ?? 0) + uploads }) });
 try {
  await c.refreshOfficial();
  const report = trace.stage("orchestrator", f.state.controlInvocationId);
  await runDecisionAgent({ coordinator: c, prompts: f.prompts, report, taskDescription: "fixture goal", signal: new AbortController().signal, attempt: 1 }, async options => {
   expect(options.tools).toEqual([]); expect(options.extensions).toBe(false); expect(options.extensionPaths).toEqual([]); expect(options.knowledge).toBeUndefined();
   receivedGoal = JSON.parse(options.prompt.split("\n").filter(line => line.startsWith('{')).at(-1)!);
   const call = async (name: string, args: any) => { c.executionGuard.beforeModelRequest(); c.executionGuard.beforeToolCall(); const result = await options.customTools!.find(t => t.name === name)!.execute(`tool-${name}`, args, new AbortController().signal, undefined, undefined as never); return JSON.parse((result.content[0] as any).text); };
   const read = () => call("pipeline_status", {});
   const start = async (stage: StageName, guidance?: string) => {
    const state = await read(); const choose = (kind: string) => state.artifacts.filter((a: any) => a.kind === kind).at(-1)?.id;
    const upstream = stage === "research" ? [] : stage === "solve" ? [choose("research_document")] : stage === "evaluate" ? [choose("training_selected_result")] : stage === "refit" ? [choose("training_selected_result"), choose("evaluation_report")] : [choose("terminal_refit_result")];
    const result = await call("stage_start", { ...request(c, stage, `model-${stage}-${c.state.counters.stages}`, upstream), guidance }); expect(result.rejected).not.toBe(true);
    await call("pipeline_wait", { cursor: state.cursor }); await c.settle();
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
  expect(c.state.status).toBe("finished"); expect(c.state.counters.trials).toBe(0);
  expect(c.state.actions.filter(a => a.kind === "stage_start").length).toBe(1 + solves * 3 + uploads);
 } finally { Object.assign(STAGE_REGISTRY, original); c.close(); await trace.close(); }
}

test("disabled policy and already-used attempts reject submission before dispatch", async () => {
 for (const [authorized, triesUsed] of [[false, 0], [true, 3]] as const) {
  const f = fixture(authorized); let effects = 0;
  const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start() { effects++; throw new Error("not reached"); }, officialStatus: async () => ({ triesUsed }) });
  await c.refreshOfficial(); expect(() => c.start(request(c, "submit", "upload"))).toThrow(/not authorized|cap is exhausted/); expect(effects).toBe(0); c.close();
 }
});

test("action dispatch failure is durable, never interpreted as agent success", () => {
 const f = fixture(), c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start() { throw new Error("mock dispatch failure"); } });
 c.start(request(c, "research", "failed")); expect(c.state.works[0].summary).toMatchObject({ outcome: "failure", error: "mock dispatch failure" });
 expect(c.state.inbox[0].kind).toBe("stage_failure"); c.close();
});

test("corrupt state and failed persistence refuse before effects; single writer lock", () => {
 const f = fixture(); expect(() => new StateStore(f.directory)).toThrow("owned by another service");
 let effects = 0; const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start() { effects++; throw new Error("should not dispatch"); } });
 const original = f.store.transaction.bind(f.store); f.store.transaction = () => { throw new Error("disk failure"); };
 expect(() => c.start(request(c, "research", "disk"))).toThrow("disk failure"); expect(effects).toBe(0);
 f.store.transaction = original; c.close(); const envelope = JSON.parse(readFileSync(f.store.path, "utf8")); envelope.state.policy.maxSubmissions = 99;
 writeFileSync(f.store.path, JSON.stringify(envelope)); expect(() => new StateStore(f.directory)).toThrow("checksum mismatch");
 envelope.sha256 = hash(envelope.state); writeFileSync(f.store.path, JSON.stringify(envelope)); expect(() => new StateStore(f.directory)).toThrow("submission policy");
});

test("restart marks lost model invocation interrupted and preserves finite budgets and cursors", async () => {
 const f = fixture(); let work!: Work;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: w => { work = w; return controllable(w).handle; } });
 c.charge("modelRequests"); c.start(request(c, "solve", "active")); c.close();
 const reopened = new StateStore(f.directory), restarted = new Coordinator(reopened, { trainingDirectory: join(f.directory, "training"), start() { throw new Error("No model reattach"); } });
 await restarted.recover(); expect(restarted.stageStatus(work.id).status).toBe("interrupted"); expect(restarted.state.counters.modelRequests).toBe(1); expect(restarted.state.counters.trials).toBe(0);
 const status = restarted.status(); expect(status.notifications[0].kind).toBe("stage_interrupted");
 await restarted.wait(status.cursor, undefined, 0); expect(restarted.status().notifications).toEqual([]);
 expect(restorePromptSnapshot(restarted.state.promptTemplates).fingerprint).toBe(f.prompts.fingerprint); restarted.close();
});

test("deterministic restart uncertainty blocks new effects without duplicating dispatch", async () => {
 const f = fixture(), c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => controllable(work).handle }); c.start(request(c, "refit", "freeze")); c.close();
 const reopened = new StateStore(f.directory); let launches = 0;
 const restarted = new Coordinator(reopened, { trainingDirectory: join(f.directory, "training"), start() { launches++; throw new Error("never"); }, recover: async () => undefined });
 await restarted.recover(); expect(restarted.state.status).toBe("blocked"); expect(restarted.state.works[0].status).toBe("uncertain"); expect(() => restarted.start(request(restarted, "solve", "more"))).toThrow("terminal"); expect(launches).toBe(0); restarted.close();
});

test("physical handoff attaches current controller state and narrow allowlist without new work", async () => {
 const f = fixture(), c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => controllable(work).handle });
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
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => controllable(work).handle }); c.charge("modelRequests"); expect(() => c.charge("modelRequests")).toThrow("budget exhausted");
 c.start(request(c, "solve", "trial-budget")); expect(c.state.works.at(-1)!.options).toEqual({ maxIterations: 2 }); expect(c.state.counters.trials).toBe(0); c.close();
 expect(parseOrchestrateArgs(["unit", "1", "task", "1", "--goal", "1", "--no-submit"]).options.noSubmit).toBe(true);
 expect(() => parseOrchestrateArgs(["task", "1", "--max-submissions", "4"])).toThrow();
 expect(() => fixture(true, { maxStages: 1000 })).toThrow("increased persisted budget");
});

test("read-only official refresh upserts pending to scored zero or one and preserves candidate evidence", async () => {
 for (const score of [0, 1]) {
  const f = fixture(); let scored = false;
  const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start() { throw new Error("No dispatch"); }, officialStatus: async () => ({ triesUsed: 1, results: [{ attemptId: "1", status: scored ? "scored" : "pending", ...(scored ? { score } : {}) }] }) });
  await c.refreshOfficial(); f.store.transaction("provenance", {}, s => { s.official[0].candidateId = "frozen-candidate"; s.official[0].artifactId = "receipt-evidence"; });
  scored = true; await c.refreshOfficial(); expect(c.state.official).toHaveLength(1);
  expect(c.state.bestOfficial).toMatchObject({ score, status: "scored", candidateId: "frozen-candidate", artifactId: "receipt-evidence" }); c.close();
 }
});

test("unknown submission reservations consume reported budget and block another upload", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: w => { owned = controllable(w); return owned.handle; } });
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
 const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory }); let uploads = 0, reconciles = 0;
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

test("recovered budget-end refit survives the deadline and still honors caller cancellation", async () => {
 const { reconcileOwnedInvocation } = await import("./run.js");
 const original = STAGE_REGISTRY.refit;
 try {
  for (const cancelledByUser of [false, true]) {
   const f = fixture(false), deadline = new AbortController(), caller = new AbortController();
   let observedAborted: boolean | undefined;
   const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory });
   STAGE_REGISTRY.refit = { name: "refit", version: 1, description: "recovery fixture", parseOptions: () => ({}), checkInput() {}, async run(context) {
    deadline.abort(); // The wall deadline passes while the recovered refit runs.
    await Bun.sleep(20);
    if (cancelledByUser) caller.abort();
    observedAborted = context.signal.aborted;
    return { artifacts: [], validation: { valid: true, errors: [] } };
   } };
   f.store.transaction("crash-during-budget-end-refit", {}, state => {
    state.actions.push({ id: "refit", kind: "budget_end_refit", requestHash: "fixture", revision: state.revision + 1, receipt: {} });
    state.works.push({ id: "refit", actionId: "refit", stage: "refit", origin: "budget_end", objective: "hand-over", upstream: [], status: "active", taskConfiguration: TASK_CONFIGURATION });
   });
   f.store.close();
   const restarted = new Coordinator(new StateStore(f.directory), { trainingDirectory: join(f.directory, "training"), start() { throw new Error("Recovery must not dispatch new work"); },
    recover: (work, input) => reconcileOwnedInvocation(work, input, { config: f.config, trace, prompts: f.prompts, signal: deadline.signal, handOverSignal: caller.signal }) });
   try {
    await restarted.recover();
    const result = restarted.state.works[0]!.result!;
    expect(result.outcome).toBe(cancelledByUser ? "cancelled" : "success");
    expect(observedAborted).toBe(cancelledByUser);
   } finally { restarted.close(); await trace.close(); }
  }
 } finally { STAGE_REGISTRY.refit = original; }
});

test("production preflight reconciles pending before unrelated model checks and stops exhausted/target runs", async () => {
 const { prepareDecisionLoop } = await import("./run.js");
 for (const early of ["pending", "exhausted", "target"] as const) {
  const f = fixture(); const order: string[] = [];
  const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => controllable(work).handle, officialStatus: async () => ({ triesUsed: early === "exhausted" ? 3 : 1, results: [{ attemptId: "1", status: early === "pending" ? "pending" : "scored", ...(early === "target" ? { score: 1 } : {}) }] }), recover: async work => { order.push("reconcile"); return fakeResult(work, { outcome: "failure", summary: { state: "pending", reservedUnknown: 0, triesUsed: 1 } }); } });
  if (early === "pending") { c.start(request(c, "refit", "placeholder")); f.store.transaction("simulate-crash-before-submit", {}, s => { s.works[0].stage = "submit"; }); }
  const ready = await prepareDecisionLoop(c, { resume: early === "pending", recoverySetup: async () => { order.push("recovery-setup"); }, allSetup: async () => { order.push("model-preflight"); throw new Error("No modelling required"); } });
  expect(ready).toBe(false); expect(order).toEqual(early === "pending" ? ["recovery-setup", "reconcile"] : ["recovery-setup"]); c.close();
 }
});

test("bounded status retains required stage inputs after many training artifact kinds", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "research", "large-catalog")); const work = c.state.works[0], path = join(f.directory, "artifact.json"); writeFileSync(path, "{}");
 const artifacts = ["research_document", ...Array.from({ length: 30 }, (_, i) => `training_detail_${i}`)].map(kind => ({ kind, path, sha256: hash("{}"), provenance: { artifactId: `${work.id}:${kind}`, taskId: "fixture", pipelineRunId: f.state.runId, invocationId: work.id, sha256: hash("{}") } }));
 owned.resolve(fakeResult(work, { artifacts })); await c.settle();
 expect(c.status().artifacts.some(a => a.kind === "research_document")).toBe(true); expect(c.status().artifacts.length).toBeLessThanOrEqual(16); c.close();
});

test("coordinator recovery reconciles an actual pending submit when its original upstream result was removed", async () => {
 const { reconcileOwnedInvocation } = await import("./run.js");
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const original = STAGE_REGISTRY.submit; const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: f.state.runId, runsDir: f.directory });
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "refit", "frozen")); const refit = c.state.works[0], path = join(f.directory, "original-refit-result.json"); writeFileSync(path, "{}");
 const artifact = { kind: "terminal_refit_result", path, sha256: hash("{}"), provenance: { artifactId: "real-upstream-reference", taskId: "fixture", pipelineRunId: f.state.runId, invocationId: refit.id, sha256: hash("{}") } };
 owned.resolve(fakeResult(refit, { artifacts: [artifact] })); await c.settle();
 c.start(request(c, "submit", "accepted-before-crash", [artifact.provenance.artifactId])); const submitId = c.state.works.at(-1)!.id;
 rmSync(path); c.close(); let uploads = 0, reconciles = 0;
 STAGE_REGISTRY.submit = { name: "submit", version: 1, description: "durable ledger", parseOptions: () => ({}), checkInput(input) { expect(input.upstream[0].sha256).toBe(hash("{}")); },
  async run() { uploads++; throw new Error("No recovery upload"); }, async reconcile(context) { reconciles++; expect(context.input.submissionPolicy?.controllerInvocationId).toBe(submitId); return { artifacts: [], validation: { valid: false, errors: ["pending"] }, summary: { state: "pending", triesUsed: 1, reservedUnknown: 0, newAttempt: false } }; } };
 const reopened = new StateStore(f.directory), restarted = new Coordinator(reopened, { trainingDirectory: join(f.directory, "training"), start() { throw new Error("No model"); }, recover: (work, input) => reconcileOwnedInvocation(work, input, { config: f.config, trace, prompts: f.prompts }) });
 try { await restarted.recover(); expect(reconciles).toBe(1); expect(uploads).toBe(0); expect(restarted.state.status).toBe("blocked"); }
 finally { STAGE_REGISTRY.submit = original; restarted.close(); await trace.close(); }
});

test("a new run reads task-global unresolved reservations before any model or stage effects", async () => {
 const { prepareDecisionLoop } = await import("./run.js");
 const f = fixture(); let effects = 0, modelChecks = 0, unresolved = true;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start() { effects++; throw new Error("No stages before task-global reconciliation"); }, officialStatus: async () => ({ triesUsed: 0, reservedUnknown: unresolved ? 1 : 0, effectiveTriesUsed: unresolved ? 1 : 0, unresolved, results: [] }) });
 const ready = await prepareDecisionLoop(c, { resume: false, recoverySetup: async () => {}, allSetup: async () => { modelChecks++; } });
 expect(ready).toBe(false); expect(c.state.works).toHaveLength(0); expect(c.state.status).toBe("blocked"); expect(c.status().budgets).toMatchObject({ triesUsed: 0, reservedUnknown: 1, effectiveTriesUsed: 1, submissionsRemaining: 2 }); expect(modelChecks).toBe(0); expect(effects).toBe(0);
 unresolved = false; await c.recover(); expect(c.state.status).toBe("running"); expect(c.state.reservedUnknown).toBe(0); c.close();
});

test("stage reports stay visible in status and are paged like the research document", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "research", "report")); const work = c.state.works[0], path = join(f.directory, "report.md");
 const text = "- **Status**: done\n" + "x".repeat(f.state.limits.maxDetailBytes + 10); writeFileSync(path, text);
 const artifacts = ["stage_report", ...Array.from({ length: 30 }, (_, i) => `training_detail_${i}`)].map(kind => ({ kind, path, sha256: hash(text), provenance: { artifactId: `${work.id}:${kind}`, taskId: "fixture", pipelineRunId: f.state.runId, invocationId: work.id, sha256: hash(text) } }));
 owned.resolve(fakeResult(work, { artifacts })); await c.settle();
 const report = c.status().artifacts.find(a => a.kind === "stage_report")!; expect(report).toBeDefined();
 const page = c.inspect(report.id) as any; expect(page.content.startsWith("- **Status**: done")).toBe(true); expect(page.nextOffset).toBe(f.state.limits.maxDetailBytes);
 expect((c.inspect(report.id, page.nextOffset) as any).nextOffset).toBeNull(); c.close();
});

test("offline runs hand over one result: a second successful refit is refused", async () => {
 const f = fixture(false); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 expect((c.status() as any).handOver).toEqual({ mode: "offline", submissionsAuthorized: false, refits: 0, allowed: 1 });
 c.start(request(c, "refit", "first-refit")); owned.resolve(fakeResult(c.state.works[0]!, { outcome: "failure" })); await c.settle();
 // A failed refit handed nothing over, so another attempt is allowed.
 c.start(request(c, "refit", "second-refit")); owned.resolve(fakeResult(c.state.works[1]!)); await c.settle();
 expect((c.status() as any).handOver.refits).toBe(1);
 expect(() => c.start(request(c, "refit", "third-refit"))).toThrow("hand over one result");
 c.close();
});

test("status shows the time used and left, without notes, and the follow-up branches", () => {
 const f = fixture(true);
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: () => { throw new Error("unused"); }, branches: () => ({ champion: null, branches: [] }) });
 const status = c.status() as any;
 expect(status.time.remainingPercent).toBeGreaterThan(95); expect(status.time).not.toHaveProperty("note");
 expect(status.handOver.submissionsAuthorized).toBe(true); expect(status.branches).toEqual({ champion: null, branches: [] });
 expect(status.trials.limit).toBe(f.state.limits.maxTrials);
 f.store.transaction("simulate-elapsed", {}, s => { s.startedAt -= Math.round(s.limits.maxWallMs * 0.6); s.deadline -= Math.round(s.limits.maxWallMs * 0.6); });
 expect((c.status() as any).time).toMatchObject({ remainingPercent: 40 }); expect((c.status() as any).time).not.toHaveProperty("note");
 c.close();
});

test("the controller's prompts describe the hand-over and no time notices", () => {
 const prompts = loadPromptSnapshot();
 expect(() => prompts.render("orchestrator.budget-low" as any, {})).toThrow();
 expect(prompts.render("orchestrator.system", {}).text).toContain("exactly one result");
 for (const id of ["orchestrator.system", "orchestrator.tool"] as const) expect(prompts.render(id, {}).text).not.toMatch(/50%|20%|at half|a fifth/);
});

/** A decision agent that charges one model request per tool call, as the real session does; the stage's own agent makes requests while it runs. */
async function waitingAgent(stageMs: number, stages = 2) {
 const f = fixture(false); let waits = 0;
 const c: Coordinator = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => {
  const owned = controllable(work), guard = c.guardFor(work.id);
  const busy = setInterval(() => guard.beforeModelRequest(), 5);
  setTimeout(() => { clearInterval(busy); owned.resolve(fakeResult(work)); }, stageMs); return owned.handle; } });
 // One model response may carry several tool calls; each call is charged before it runs.
 const response = () => c.executionGuard.beforeModelRequest(), tool = async (fn: () => unknown) => { c.executionGuard.beforeToolCall(); return fn(); };
 for (let i = 0; i < stages; i++) {
  response(); const cursor = ((await tool(() => c.status())) as any).cursor;
  // The next response starts the stage and waits for it: one pipeline_wait, returning only with the result.
  response(); await tool(() => c.start(request(c, "research", `research-${i}`)));
  const after = await tool(() => c.wait(cursor)) as any; waits++;
  expect(after.notifications.map((n: any) => n.kind)).toContain("stage_terminal");
 }
 await c.settle();
 // Between each stage's dispatch and its result, only that stage's agent reserved anything.
 const journal = c.state.journal, reservations = journal.filter(e => e.kind === "budget_reserved");
 let whileWaiting = 0, waitCalls = 0, stageRequests = 0;
 for (const work of c.state.works) {
  const from = journal.findIndex(e => e.kind === "stage_dispatched" && e.payload.invocationId === work.id), to = journal.findIndex(e => e.kind === "stage_completed" && e.payload.invocationId === work.id);
  const orchestrator = journal.slice(from, to).filter(e => e.kind === "budget_reserved" && e.payload.source === "orchestrator");
  // The only orchestrator entry in the window is the tool call that issues pipeline_wait itself.
  whileWaiting += orchestrator.filter(e => e.payload.counter !== "toolCalls").length; waitCalls += orchestrator.filter(e => e.payload.counter === "toolCalls").length;
  stageRequests += journal.slice(from, to).filter(e => e.kind === "budget_reserved" && e.payload.source === work.id).length;
 }
 expect(reservations.every(e => typeof e.payload.source === "string")).toBe(true); expect(stageRequests).toBeGreaterThan(0);
 const orchestratorRequests = reservations.filter(e => e.payload.source === "orchestrator" && e.payload.counter === "modelRequests").length;
 const result = { orchestratorRequests, waits, whileWaiting, waitCalls, timeNotices: journal.filter(e => /time/.test(e.kind)).length }; c.close(); return { ...result, stageRequests };
}

test("pipeline_wait makes no model requests while a stage runs: the count is the same for short and long stages", async () => {
 // Stand-ins for N = 1 s and N = 30 s keep the 1:30 ratio (20 ms and 600 ms); ORCHESTRATOR_REAL_WAIT=1 uses the real durations.
 const [shortMs, longMs] = process.env.ORCHESTRATOR_REAL_WAIT ? [1000, 30_000] : [20, 600];
 const { stageRequests: shortStage, ...short } = await waitingAgent(shortMs), { stageRequests: longStage, ...long } = await waitingAgent(longMs);
 expect(long).toEqual(short); expect(short).toEqual({ orchestratorRequests: 4, waits: 2, whileWaiting: 0, waitCalls: 2, timeNotices: 0 });
 expect(longStage).toBeGreaterThan(shortStage);
 console.log(`[measure] stages of ${shortMs} ms and ${longMs} ms: orchestrator model requests for 2 stages: short=${short.orchestratorRequests} long=${long.orchestratorRequests}; wait returns short=${short.waits} long=${long.waits}; orchestrator model requests/sessions between stage start and result: ${short.whileWaiting}/${long.whileWaiting} (tool-call entries: the ${short.waitCalls} wait calls); stage-agent requests short=${shortStage} long=${longStage}`);
}, 120_000);

test("state storage permits optional source metadata within the current harness version", () => {
 const f = fixture(false); const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: () => { throw new Error("unused"); } });
 f.store.transaction("budget_reserved", { counter: "modelRequests" }, s => { s.counters.modelRequests++; }); c.close();
 const reopened = new StateStore(f.directory); expect(reopened.state.journal.at(-1)!.payload).toEqual({ counter: "modelRequests" }); reopened.close();
});

test("pipeline_wait returns at the deadline when no stage reports", async () => {
 const f = fixture(false); const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => controllable(work).handle });
 c.start(request(c, "research", "hangs"));
 f.store.transaction("simulate-elapsed", {}, s => { s.startedAt = Date.now() + 150 - s.limits.maxWallMs; s.deadline = s.startedAt + s.limits.maxWallMs; });
 const started = Date.now(); const status = await c.wait(c.state.cursor) as any;
 expect(Date.now() - started).toBeGreaterThanOrEqual(100); expect(Date.now() - started).toBeLessThan(2000);
 expect(status.works.at(-1).status).toBe("active"); expect(status.time.remainingMinutes).toBe(0);
 await c.stop("fixture"); c.close();
});

test("research and solve never receive the confirmation or anything the reviewer produced", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "evaluate", "review")); const work = c.state.works[0]!, path = join(f.directory, "handoff.md"); writeFileSync(path, "sealed 0.91");
 const artifacts = ["stage_report", "evaluation_report"].map(kind => ({ kind, path, sha256: hash("sealed 0.91"), provenance: { artifactId: `${work.id}:${kind}`, taskId: "fixture", pipelineRunId: f.state.runId, invocationId: work.id, sha256: hash("sealed 0.91") } }));
 owned.resolve(fakeResult(work, { artifacts })); await c.settle();
 for (const stage of ["research", "solve"] as const) {
  expect(() => c.start(request(c, stage, `${stage}-upstream`, [`${work.id}:stage_report`]))).toThrow("Held-back confirmation must not enter");
  expect(() => c.start({ ...request(c, stage, `${stage}-evidence`), evidenceIds: [`${work.id}:evaluation_report`], guidance: "Use the review" })).toThrow("Held-back confirmation must not enter");
 }
 c.close();
});

test("a solve after a successful solve is not a retry, a solve after a failed one is", async () => {
 const f = fixture(); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "solve", "s1")); owned.resolve(fakeResult(c.state.works[0]!, { outcome: "failure" })); await c.settle();
 c.start(request(c, "solve", "s2")); owned.resolve(fakeResult(c.state.works[1]!)); await c.settle();
 expect(c.state.counters.retries).toBe(1);
 c.start(request(c, "solve", "s3")); owned.resolve(fakeResult(c.state.works[2]!, { outcome: "failure" })); await c.settle();
 expect(c.state.counters.retries).toBe(1);
 c.close();
});

test("a branch list too large for the status budget is dropped, not fatal", () => {
 const f = fixture(true, { maxSummaryBytes: 6000 });
 const big = { branches: Array.from({ length: 8 }, (_, i) => ({ name: `followup/fixture/${i}`, subject: "x".repeat(2000) })) };
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: () => { throw new Error("unused"); }, branches: () => big });
 expect((c.status() as any).branches).toEqual({ omitted: "Branch list did not fit the status budget" });
 c.close();
});

test("the trial counter equals the distinct trials run, also after an interrupted solve and its recovery", async () => {
 const f = fixture(false); let owned!: ReturnType<typeof controllable>;
 const solveResult = (work: Work, ids: string[], extra: Partial<StageInvocation> = {}) => {
  for (const id of ids) writeStartedTrial(f, work.id, id);
  return fakeResult(work, extra);
 };
 let c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 // A solve that ran two of its six allowed trials is charged two.
 c.start(request(c, "solve", "first")); expect(c.state.counters.trials).toBe(0); expect((c.status() as any).trials.runningSolveAllocation).toBe(6);
 owned.resolve(solveResult(c.state.works.at(-1)!, ["t1", "t2"])); await c.settle(); expect(c.state.counters.trials).toBe(2);
 // A second solve starts (it runs t3 and t4 in its root), then the host dies.
 c.start(request(c, "solve", "lost")); expect(c.state.works.at(-1)!.options).toEqual({ maxIterations: 6 }); c.close();
 const reopened = new StateStore(f.directory);
 c = new Coordinator(reopened, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 await c.recover(); expect(c.state.works.at(-1)!.status).toBe("interrupted");
 // The interrupted solve keeps no reservation: the recovery gets the full allocation from what is left.
 expect(c.state.counters.trials).toBe(2);
 c.start(request(c, "solve", "recovering")); expect(c.state.works.at(-1)!.options).toEqual({ maxIterations: 6 });
 // It reuses the lost solve's root, so it reports t3 and t4 again with its own t5; a stale t2 is not charged twice.
 owned.resolve(solveResult(c.state.works.at(-1)!, ["t2", "t3", "t4", "t5"])); await c.settle();
 expect(c.state.counters.trials).toBe(5); expect(c.state.trialIds).toEqual(["t1", "t2", "t3", "t4", "t5"]);
 // A cancelled solve is charged for the trials it ran before the cancel.
 c.start(request(c, "solve", "cancelled")); owned.resolve(solveResult(c.state.works.at(-1)!, ["t6"], { outcome: "cancelled" })); await c.settle();
 expect(c.state.counters.trials).toBe(6);
 console.log(`[measure] trials run: 6 distinct (t1..t6), trial counter: ${c.state.counters.trials}`);
 c.close(); const persisted = new StateStore(f.directory); expect(persisted.state.counters.trials).toBe(6); persisted.close();
});

test("a solve's allocation never exceeds what is left of the run's trials", () => {
 const f = fixture(false, { maxTrials: 8 }); let owned!: ReturnType<typeof controllable>;
 const c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "solve", "one")); for (const id of ["a", "b", "c", "d", "e"]) writeStartedTrial(f, c.state.works[0]!.id, id); owned.resolve(fakeResult(c.state.works[0]!));
 return c.settle().then(() => { c.start(request(c, "solve", "two")); expect(c.state.works.at(-1)!.options).toEqual({ maxIterations: 3 }); c.close(); });
});

function writeStartedTrial(f: ReturnType<typeof fixture>, invocationId: string, id: string, runId = f.state.runId, charged = true) {
 const directory = join(f.directory, "training", invocationId, id); mkdirSync(directory, { recursive: true });
 writeFileSync(join(directory, "recovery.json"), JSON.stringify({ schemaVersion: 1, trial: { id }, budgetUnit: id, budgetCharged: charged, originPipelineRunId: runId, originStageInvocationId: invocationId }));
 writeFileSync(join(directory, "experiment.json"), JSON.stringify({ id, pid: 123 }));
}
test("trial accounting excludes pre-spawn intents and accepts a runner receipt before supervisor persistence", async () => {
 const { startedTrials } = await import("./training_facts.js");
 const f = fixture(false), root = join(f.directory, "training");
 try {
  writeStartedTrial(f, "solve", "intent");
  rmSync(join(root, "solve", "intent", "experiment.json"));
  expect(startedTrials(root, f.state.runId, ["solve"])).toEqual([]);
  const directory = join(root, "solve", "intent"), path = join(directory, "recovery.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), token: "new-launch" }));
  writeFileSync(join(directory, "worker-owner.json"), JSON.stringify({ token: "stale-launch", identity: { pid: 123, birth: "boot:1" } }));
  expect(startedTrials(root, f.state.runId, ["solve"])).toEqual([]);
  writeFileSync(join(directory, "worker-owner.json"), JSON.stringify({ token: "new-launch", identity: { pid: 123, birth: "boot:1" } }));
  expect(startedTrials(root, f.state.runId, ["solve"])).toEqual(["intent"]);
  writeFileSync(join(directory, "experiment.json"), JSON.stringify({ id: "intent", pid: 123 }));
  expect(startedTrials(root, f.state.runId, ["solve"])).toEqual(["intent"]);
 } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
for (const outcome of ["cancelled", "throws", "interrupted"] as const) test(`durable trials are counted when solve ${outcome} without returning a summary`, async () => {
 const f = fixture(false); let owned!: ReturnType<typeof controllable>;
 let c = new Coordinator(f.store, { trainingDirectory: join(f.directory, "training"), start: work => { owned = controllable(work); return owned.handle; } });
 c.start(request(c, "solve", "lost")); const work = c.state.works.at(-1)!;
 writeStartedTrial(f, work.id, "t1"); writeStartedTrial(f, work.id, "t2");
 writeStartedTrial(f, work.id, "foreign", "another-run"); writeStartedTrial(f, work.id, "failed-launch", f.state.runId, false);
 if (outcome === "interrupted") {
  c.close(); c = new Coordinator(new StateStore(f.directory), { trainingDirectory: join(f.directory, "training"), start: () => { throw new Error("unused"); } });
  await c.recover(); expect(c.state.works.at(-1)!.status).toBe("interrupted");
 } else {
  if (outcome === "throws") owned.reject(new Error("solve died during confirmation"));
  else owned.handle.cancel();
  await c.settle();
 }
 expect(c.state.counters.trials).toBe(2); expect(c.state.trialIds).toEqual(["t1", "t2"]);
 if (outcome === "interrupted") { await c.recover(); expect(c.state.counters.trials).toBe(2); }
 c.close(); const saved = new StateStore(f.directory); expect(saved.state.counters.trials).toBe(2); saved.close();
});

test("real resume rejects a previous harness version before changing state or charging budgets", async () => {
 const { runOrchestrator } = await import("./run.js");
 const f = fixture(false); f.store.close();
 const old: any = structuredClone(f.state); delete old.harnessVersion;
 old.promptTemplates["orchestrator.budget-half"] = "old prompt";
 old.promptTemplates["orchestrator.budget-low"] = "old prompt";
 old.counters.trials = 6; delete old.trialIds;
 // Task lookup needs metadata, not private spam1 data or an authenticated fetch.
 const unit = mkdtempSync(join(PROJECT_ROOT, "units", "99-version-fixture-"));
 const taskId = unit.split("/").at(-1)!;
 try {
  const taskDirectory = join(unit, "task"); mkdirSync(taskDirectory);
  writeFileSync(join(taskDirectory, "meta.json"), JSON.stringify({ short_id: taskId, task: "Version rejection fixture" }));
  const directory = join(f.directory, taskId, "pipeline", "old-run"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.json"), bytes = JSON.stringify({ state: old, sha256: hash(old) }); writeFileSync(path, bytes);
  await expect(runOrchestrator({ taskId, runsDir: f.directory, resumeRunId: "old-run", configPath: join(f.directory, "missing-config.json") })).rejects.toThrow("started by a different harness version; a new run must be started");
  expect(readFileSync(path, "utf8")).toBe(bytes);
 } finally { rmSync(unit, { recursive: true, force: true }); rmSync(f.directory, { recursive: true, force: true }); }
});
