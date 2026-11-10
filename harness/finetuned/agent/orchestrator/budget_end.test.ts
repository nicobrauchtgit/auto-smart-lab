/** Budget end: the harness hands over what exists, and spent counters end the decision loop once. */
import { testTelemetry } from "../telemetry/testing.js";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, StateStore, hash, type RunState, type Work } from "./state.js";
import { Coordinator } from "./coordinator.js";
import { runDecisionLoop } from "./run.js";
import { formatProgress } from "./progress.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { startStageInvocation } from "../pipeline/executor.js";
import type { StageName } from "../pipeline/types.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";

const original = { ...STAGE_REGISTRY };
afterEach(() => { Object.assign(STAGE_REGISTRY, original); });

type Behaviour = { solveValid?: boolean; cancelAfterPromotion?: boolean; solveMs?: number; researchMs?: number; refitMs?: number };
/**
 * A coordinator whose stages run through the real executor with fake stage
 * bodies, wired like run.ts: stages stop at the deadline, the budget-end refit
 * stops only on a cancel by the caller.
 */
async function harness(limits: Partial<RunState["limits"]>, behaviour: Behaviour = {}, authorized = false) {
 const directory = mkdtempSync(join(tmpdir(), "budget-end-")), prompts = loadPromptSnapshot();
 const config = resolvePipelineSettings({ defaultModel: "fixture/model", providers: {}, agent: { cwd: directory, agentDir: directory, initialPrompt: "" }, pipeline: { version: 1, scheduling: "agent", entryStage: "research", stages: Object.fromEntries(["research", "solve", "evaluate", "refit", "submit"].map(name => [name, { enabled: true, options: {} }])) } } as any);
 const store = new StateStore(directory, initialState({ taskId: "fixture", taskFingerprint: "a".repeat(64), config, promptTemplates: prompts.serialize(), promptFingerprint: prompts.fingerprint, authorized, limits }));
 const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: store.state.runId, runsDir: directory });
 let promoted: any;
 const deliveries = join(directory, "deliveries"); const lines: string[] = []; const refitSignals: AbortSignal[] = [];
 const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true }); });
 const artifact = (kind: string, id: string, contents: string) => { const path = join(directory, id, kind === "training_selected_result" ? "trial-result.json" : `${kind}.json`); mkdirSync(join(directory, id), { recursive: true }); writeFileSync(path, contents); return { kind, path, sha256: hash(contents) }; };
 for (const name of ["research", "solve", "refit"] as StageName[]) STAGE_REGISTRY[name] = { name, version: 1, description: name, parseOptions: raw => raw ?? {}, checkInput() {}, async run(context) {
  const id = context.report.agentIdentity(1).stageInvocationId!;
  if (name === "research") { await sleep(behaviour.researchMs ?? 10, context.signal); return { artifacts: [artifact("research_document", id, "# research")], validation: { valid: true, errors: [] } }; }
  if (name === "solve") {
   await sleep(behaviour.solveMs ?? 10, context.signal);
   if (behaviour.solveValid === false) return { artifacts: [], validation: { valid: false, errors: ["no eligible trial"] }, summary: { trial_ids: ["t1"] } };
   const selected = artifact("training_selected_result", `trial-${id}`, JSON.stringify({ experimentId: `trial-${id}`, balancedAccuracy: 0.99 }));
   const trialDirectory = join(directory, `trial-${id}`);
   writeFileSync(join(trialDirectory, "recovery.json"), JSON.stringify({ originPipelineRunId: store.state.runId, originStageInvocationId: id }));
   promoted = { experimentId: `trial-${id}`, directory: trialDirectory, artifacts: [{ ...selected, kind: "training_trial_result" }] };
   if (behaviour.cancelAfterPromotion) await sleep(60_000, context.signal);
   return { artifacts: [selected], validation: { valid: true, errors: [] }, summary: { trial_ids: [`trial-${id}`] } };
  }
  refitSignals.push(context.signal);
  expect(context.input.upstream.map(a => a.kind)).toContain("training_selected_result");
  await sleep(behaviour.refitMs ?? 10, context.signal);
  mkdirSync(deliveries, { recursive: true }); writeFileSync(join(deliveries, "output.csv"), "1;0\n"); writeFileSync(join(deliveries, "manifest.json"), "{}");
  return { artifacts: [artifact("terminal_refit_result", id, JSON.stringify({ deliveries }))], validation: { valid: true, errors: [] } };
 } };
 const controller = new AbortController(), handOver = new AbortController();
 let deadlineReached = false;
 const timer = setTimeout(() => { deadlineReached = true; controller.abort(); }, Math.max(0, store.state.deadline - Date.now()));
 const coordinator: Coordinator = new Coordinator(store, { promotedChampion: async () => promoted, progress: event => lines.push(formatProgress(event)),
  start: (work, input) => startStageInvocation({ invocationId: work.id, stage: work.stage, input, config, trace, prompts, optionOverrides: work.options,
   ...(work.origin === "budget_end" ? { reason: "budget_end_hand_over", signal: handOver.signal } : { reason: "orchestrator_decision", signal: controller.signal, executionGuard: coordinator.guardFor(work.id) }) }) });
 coordinator.configure({ actionId: "configure", expectedRevision: coordinator.state.revision, rationale: "fixture", configuration: spamConfiguration() });
 const events: { type: string; payload: unknown }[] = [];
 const loop = { deadlineReached: () => deadlineReached, userCancelled: () => false, report: { event: (type: string, payload: unknown) => { events.push({ type, payload }); } } };
 const start = (stage: StageName, artifactIds: string[] = []) => { coordinator.executionGuard.beforeModelRequest(); return coordinator.start({ stage, actionId: `${stage}-${coordinator.state.revision}`, expectedRevision: coordinator.state.revision, rationale: "fixture decision", objective: `Run ${stage} for the fixture task with a measured result`, artifactIds }); };
 const wait = async () => { coordinator.executionGuard.beforeModelRequest(); return coordinator.wait(coordinator.state.cursor); };
 const close = async () => { clearTimeout(timer); coordinator.close(); await trace.close(); };
 return { coordinator, loop, start, wait, close, lines, events, deliveries, refitSignals, directory, isDeadline: () => deadlineReached };
}
const newest = (c: Coordinator, kind: string) => c.state.artifacts.filter(a => a.kind === kind).at(-1)!.id;

test("a run that hits its deadline with a champion ends with a harness refit and hand-over files", async () => {
 const h = await harness({ maxWallMs: 1500 }, { researchMs: 60_000, refitMs: 400 });
 let calls = 0;
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => {
  calls++;
  h.start("solve"); await h.wait(); expect(h.coordinator.champion()).toBeDefined();
  // A long research round outlives the deadline; the wait returns at the deadline.
  h.start("research"); await h.wait();
  h.coordinator.executionGuard.beforeModelRequest(); // the next request after the deadline is refused
 } });
 const s = h.coordinator.state, refit = s.works.find(w => w.origin === "budget_end")!;
 expect(calls).toBe(1); expect(ended.budgetEnd).toBe("deadline reached");
 expect(s.works.find(w => w.stage === "research")!.result?.outcome).toBe("cancelled");
 expect(refit.stage).toBe("refit"); expect(refit.result?.outcome).toBe("success"); expect(refit.upstream).toContain(newest(h.coordinator, "training_selected_result"));
 // The refit ran to its end after the deadline: its signal was never aborted.
 expect(h.isDeadline()).toBe(true); expect(h.refitSignals[0].aborted).toBe(false); expect(Date.parse(refit.result!.finishedAt)).toBeGreaterThan(s.deadline);
 expect(existsSync(join(h.deliveries, "output.csv"))).toBe(true);
 expect(s.status).toBe("finished"); expect(s.reason).toStartWith("Handed over at budget end (deadline reached)");
 expect(s.journal.map(e => e.kind)).toEqual(expect.arrayContaining(["budget_end_refit_accepted", "budget_end"]));
 expect(s.actions.find(a => a.kind === "budget_end_refit")).toBeDefined();
 expect(h.lines.some(l => /stage started: refit .*harness hand-over at budget end/.test(l))).toBe(true);
 expect(h.lines.some(l => /hand-over: Handed over at budget end/.test(l))).toBe(true);
 console.log(`[measure] deadline with champion: ${s.reason}; refit finished ${Date.parse(refit.result!.finishedAt) - s.deadline} ms after the deadline`);
 await h.close();
 // The durable state stays valid and loads again.
 const reopened = new StateStore(h.directory); expect(reopened.state.status).toBe("finished"); reopened.close();
});

test("a run that hits its deadline without a champion says that nothing could be handed over", async () => {
 const h = await harness({ maxWallMs: 800 }, { solveValid: false, researchMs: 60_000 });
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => {
  h.start("solve"); await h.wait(); h.start("research"); await h.wait(); h.coordinator.executionGuard.beforeModelRequest();
 } });
 const s = h.coordinator.state;
 expect(ended.handOver).toMatchObject({ handedOver: false }); expect(s.works.some(w => w.stage === "refit")).toBe(false);
 expect(s.status).toBe("cancelled"); expect(s.reason).toBe("Budget end (deadline reached): nothing to hand over; no solve produced a validated champion");
 expect(existsSync(h.deliveries)).toBe(false);
 expect(h.lines.at(-1)).toMatch(/hand-over: none — Budget end \(deadline reached\): nothing to hand over/);
 console.log(`[measure] deadline without champion: ${s.reason}`);
 await h.close();
});

test("exhausted counters end the decision loop once, without burning retries, and hand over the champion", async () => {
 const h = await harness({ maxModelRequests: 4 });
 let sessions = 0;
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => {
  sessions++;
  if (sessions === 1) { h.start("solve"); await h.wait(); }
  for (;;) h.coordinator.executionGuard.beforeModelRequest(); // the session fails when requests run out
 } });
 const s = h.coordinator.state;
 expect(sessions).toBe(1); expect(s.counters.retries).toBe(0); expect(s.counters.modelRequests).toBe(4);
 expect(ended.budgetEnd).toBe("modelRequests budget exhausted");
 expect(s.status).toBe("finished"); expect(s.reason).toStartWith("Handed over at budget end (modelRequests budget exhausted)");
 expect(h.events.filter(e => e.type === "orchestrator_session_restart")).toHaveLength(0);
 console.log(`[measure] spent counters: ${sessions} decision session(s), ${s.counters.retries} retries charged (limit ${s.limits.maxRetries}); ${s.reason}`);
 await h.close();
});

test("transient session failures still restart, and a spent retry budget ends the loop once", async () => {
 const h = await harness({ maxRetries: 2 });
 let sessions = 0;
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => { sessions++; throw new Error("provider hiccup"); } });
 expect(sessions).toBe(3); expect(h.coordinator.state.counters.retries).toBe(2); expect(ended.budgetEnd).toBe("retries budget exhausted");
 expect(h.coordinator.state.reason).toContain("nothing to hand over");
 await h.close();
});

test("a decision agent that stops without finishing lets the running solve end, then hands over its champion", async () => {
 const h = await harness({}, { solveMs: 300 });
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => { h.start("solve"); } });
 const s = h.coordinator.state;
 expect(ended.budgetEnd).toBe("the decision agent stopped without finishing");
 expect(s.works[0].result?.outcome).toBe("success"); expect(s.works.at(-1)!.origin).toBe("budget_end");
 expect(s.status).toBe("finished"); expect(existsSync(join(h.deliveries, "output.csv"))).toBe(true);
 await h.close();
});

test("a champion the agent already refit is not refit again; offline nothing is uploaded", async () => {
 const h = await harness({});
 const ended = await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => {
  h.start("solve"); await h.wait(); h.start("refit", [newest(h.coordinator, "training_selected_result")]); await h.wait();
 } });
 const s = h.coordinator.state;
 expect(s.works.filter(w => w.stage === "refit")).toHaveLength(1); expect(s.works.some(w => w.stage === "submit")).toBe(false);
 expect(ended.handOver?.reason).toContain("already handed over");
 expect(h.lines.filter(l => l.includes("hand-over:"))).toHaveLength(2);
 await h.close();
});

test("online, the budget-end hand-over refits but never submits", async () => {
 const h = await harness({}, {}, true);
 await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => { h.start("solve"); await h.wait(); } });
 const s = h.coordinator.state;
 expect(s.policy.authorized).toBe(true); expect(s.works.map(w => w.stage)).toEqual(["solve", "refit"]); expect(s.status).toBe("finished");
 await h.close();
});

test("progress lines name the stage, the objective's first words, outcome, validity and duration", () => {
 const now = new Date("2026-11-10T12:00:00Z");
 expect(formatProgress({ kind: "stage_started", stage: "solve", invocationId: "0123456789", objective: "Build a binary TF-IDF pipeline with a linear SVM and five stratified folds" }, now))
  .toBe('[run 2026-11-10 12:00:00Z] stage started: solve 01234567 — "Build a binary TF-IDF pipeline with a linear SVM and …"');
 expect(formatProgress({ kind: "stage_finished", stage: "solve", invocationId: "0123456789", outcome: "success", valid: true, durationMs: 754_000 }, now)).toBe("[run 2026-11-10 12:00:00Z] stage finished: solve 01234567 success, valid, 12m 34s");
 expect(formatProgress({ kind: "run_ended", runId: "r", outcome: "failure", reason: "x" }, now)).toBe("[run 2026-11-10 12:00:00Z] run r ended: failure — x");
});

test("deadline hands over a promoted trial while its solve is still running and then cancelled", async () => {
 const h = await harness({ maxWallMs: 800 }, { cancelAfterPromotion: true });
 await runDecisionLoop(h.coordinator, { ...h.loop, runAgent: async () => {
  h.start("solve"); await h.wait(); h.coordinator.executionGuard.beforeModelRequest();
 } });
 expect(h.coordinator.state.works[0]!.result?.outcome).toBe("cancelled");
 expect(h.coordinator.state.status).toBe("finished");
 expect(h.coordinator.state.journal.some(e => e.kind === "champion_evidence_reconciled")).toBe(true);
 expect(existsSync(join(h.deliveries, "output.csv"))).toBe(true);
 await h.close();
});
