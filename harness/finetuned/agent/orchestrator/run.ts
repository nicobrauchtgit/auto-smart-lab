/** Dynamic scheduling uses the same trace, preflight and stage executor as configured runs. */
import { dirname, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadResolvedPipelineConfig } from "../pipeline/config.js";
import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { getStage } from "../pipeline/registry.js";
import { startStageInvocation, invokeStage, type InvokeStageOptions } from "../pipeline/executor.js";
import { loadPromptSnapshot, restorePromptSnapshot } from "../prompts/loader.js";
import { buildResearchContext } from "../research/context.js";
import { claimWorkspace } from "../experiments/ownership.js";
import { ensureTaskData } from "../setup/task_data.js";
import { TaskKnowledge } from "../knowledge/service.js";
import { readSubmissionAccounting, submissionTransport } from "../submission/index.js";
import { initialState, StateStore, hash, type Limits, type Work } from "./state.js";
import { inspectTaskData, listTaskDataFiles, projectPython } from "../pipeline/task_configuration.js";
import { Coordinator } from "./coordinator.js";
import { formatProgress, type RunProgressEvent } from "./progress.js";
import { runDecisionAgent } from "./session.js";
import type { PipelineRunResult, StageInput, StageReporter } from "../pipeline/types.js";
import { statePath } from "../paths.js";
import { followUpBranches } from "../training/branches.js";
export interface OrchestratorOptions {
 telemetry?: import("../telemetry/runtime.js").TelemetryOptions;
 taskId: string; targetScore?: number; maxSubmissions?: number; noSubmit?: boolean; checkSetupOnly?: boolean;
 model?: string; configPath?: string; runsDir?: string; resumeRunId?: string; limits?: Partial<Limits>; signal?: AbortSignal;
 /** Receives one line per run event (stage started/finished, hand-over, run start/end). Defaults to stdout. */
 progress?: (line: string) => void;
}
function boundedFile(path: string, maxBytes = 24000): string { if (statSync(path).size > maxBytes) throw new Error("Task description exceeds opening input bound"); return readFileSync(path, "utf8"); }
/** The production restart path has no fallback to a submission upload runner. */
export function reconcileOwnedInvocation(work: Work, input: StageInput, options: Omit<InvokeStageOptions, "stage" | "input" | "invocationId" | "mode">) {
 if (work.stage !== "refit" && work.stage !== "submit") return Promise.resolve(undefined);
 return invokeStage({ ...options, invocationId: work.id, stage: work.stage, input, mode: work.stage === "submit" ? "reconcile" : "execute" });
}
/** Return false when recovery/official state terminates work before model setup. */
export async function prepareDecisionLoop(coordinator: Coordinator, options: { resume: boolean; recoverySetup(): Promise<void>; allSetup(): Promise<void> }): Promise<boolean> {
 await options.recoverySetup();
 if (options.resume) await coordinator.recover(); else await coordinator.refreshOfficial();
 coordinator.finishIfOfficialComplete();
 if (coordinator.state.status !== "running") return false;
 await options.allSetup(); return true;
}
export interface DecisionLoopOptions {
 runAgent(attempt: number): Promise<unknown>;
 /** True once the run's deadline passed; running stages are then cancelled before the hand-over. */
 deadlineReached(): boolean;
 /** True when the caller cancelled the run; a cancel never triggers a budget-end hand-over. */
 userCancelled(): boolean;
 report: Pick<StageReporter, "event">;
}
/**
 * Run decision sessions until the agent finishes, the caller cancels, or the
 * budget ends. A failed physical session is restarted with a retry charge; a
 * spent counter or the deadline ends the loop once instead. When the loop ends
 * without a finish, the harness hands over what exists.
 */
export async function runDecisionLoop(coordinator: Coordinator, options: DecisionLoopOptions) {
 let attempt = coordinator.state.counters.sessions + 1, budgetEnd: string | undefined;
 const deadline = () => options.deadlineReached() || Date.now() >= coordinator.state.deadline;
 const spent = () => { if (deadline()) return "deadline reached"; const counter = coordinator.exhausted(); return counter ? `${counter} budget exhausted` : undefined; };
 for (;;) {
  if (options.userCancelled()) throw new Error("Run cancelled");
  if ((budgetEnd = spent())) break;
  options.report.event("agent_attempt_start", { attempt, role: "orchestrator" });
  try {
   await options.runAgent(attempt);
   if (coordinator.state.status === "running") budgetEnd = spent() ?? "the decision agent stopped without finishing";
   break;
  } catch (error) {
   if (coordinator.state.status !== "running") break;
   if (options.userCancelled()) throw error;
   if ((budgetEnd = spent())) break;
   if (coordinator.state.counters.retries >= coordinator.state.limits.maxRetries) { budgetEnd = "retries budget exhausted"; break; }
   coordinator.charge("retries");
   options.report.event("orchestrator_session_restart", { attempt, reason: "Physical session failed; durable coordinator and owned work retained" }); attempt++;
  } finally { options.report.event("agent_attempt_end", { attempt, role: "orchestrator", revision: coordinator.state.revision }); }
 }
 if (!budgetEnd) return {};
 options.report.event("budget_end", { why: budgetEnd });
 const handOver = await coordinator.handOverAtBudgetEnd(budgetEnd, { cancelLive: deadline() });
 options.report.event("budget_end_hand_over", handOver);
 return { budgetEnd, handOver };
}
export async function runOrchestrator(options: OrchestratorOptions): Promise<PipelineRunResult> {
 const task = resolveTask({ taskId: options.taskId });
 const runsDir = options.runsDir ?? statePath(PROJECT_ROOT);
 if (options.resumeRunId && !/^[A-Za-z0-9_-]{1,128}$/.test(options.resumeRunId)) throw new Error("Invalid resume run ID");
 const releaseWorkspace = claimWorkspace(join(runsDir, task.taskId, "orchestrator-ownership"));
 let store: StateStore | undefined, coordinator: Coordinator | undefined, trace: Awaited<ReturnType<typeof createPipelineTrace>> | undefined;
 // `controller` stops the decision loop and its stages at the deadline or on a
 // cancel; `handOver` stops only on a cancel, so a budget-end refit can finish.
 const controller = new AbortController(), handOver = new AbortController();
 let deadlineReached = false;
 const cancel = () => { handOver.abort(); controller.abort(); }; options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
 const print = (event: RunProgressEvent) => { try { (options.progress ?? console.log)(formatProgress(event)); } catch { /* advisory */ } };
 let timer: ReturnType<typeof setTimeout> | undefined;
 let finalResult: PipelineRunResult | undefined;
 let stoppedBecause = "", outcome: PipelineRunResult["outcome"] = "failure";
 try {
  const { resolved: config } = await loadResolvedPipelineConfig(options.configPath);
  // The task's own data, downloaded only if missing, before its dataset fingerprint is taken.
  const taskData = await ensureTaskData(task.taskId, { signal: controller.signal, offline: !config.online });
  const snapshot = loadPromptSnapshot(), runId = options.resumeRunId ?? randomUUID();
  const { context } = buildResearchContext(task.taskId);
  const taskDescription = [boundedFile(join(task.taskDir, "prompt.md")), ...(existsSync(join(dirname(task.taskDir), "unit-intro.md")) ? [boundedFile(join(dirname(task.taskDir), "unit-intro.md"), 16000)] : [])].join("\n\n");
  const taskFingerprint = hash({ taskId: task.taskId, taskDescription, dataset: context.dataset.snapshot_sha256 });
  store = new StateStore(join(runsDir, task.taskId, "pipeline", runId), options.resumeRunId ? undefined : initialState({ taskId: task.taskId, taskFingerprint, config, promptTemplates: snapshot.serialize(), promptFingerprint: snapshot.fingerprint,
   // Submitting needs the online experiment as well as an explicit caller policy.
   authorized: config.online && options.noSubmit !== true && options.maxSubmissions !== 0 && config.enabledStages.includes("submit"), maxSubmissions: options.maxSubmissions, targetScore: options.targetScore, limits: options.limits, runId }));
  const saved = store.state;
  if (saved.taskFingerprint !== taskFingerprint || saved.config.fingerprint !== config.fingerprint) throw new Error("Task/config changed since this run; refusing resumed effects");
  if (options.resumeRunId && ((options.targetScore !== undefined && options.targetScore !== saved.goal.targetScore) || (options.maxSubmissions !== undefined && options.maxSubmissions !== saved.policy.maxSubmissions) || (options.noSubmit === true && saved.policy.authorized))) throw new Error("Resume policy is immutable; start a separate no-submit run instead");
  const prompts = restorePromptSnapshot(saved.promptTemplates);
  if (prompts.fingerprint !== saved.promptFingerprint) throw new Error("Persisted prompt fingerprint mismatch");
  trace = await createPipelineTrace({ taskId: task.taskId, pipelineRunId: saved.runId, runsDir, telemetry: options.telemetry });
  const previousTraceId = [...saved.journal].reverse().find(entry => entry.kind === "telemetry_execution_started")?.payload.traceId;
  store.transaction("telemetry_execution_started", { traceId: trace.traceId, previousTraceId: previousTraceId ?? null, executionId: trace.telemetry.executionId }, () => {});
  const report = trace.stage("orchestrator", saved.controlInvocationId);
  if (!options.checkSetupOnly) print({ kind: "run_started", runId: saved.runId, taskId: task.taskId, resumed: !!options.resumeRunId, stateDirectory: store.directory });
  const setup = new SetupSession();
  const available = saved.config.enabledStages.filter(name => name !== "submit" || saved.policy.authorized);
  trace.event("task_data_ready", { downloaded: taskData.downloaded, present: taskData.present, legacy: taskData.legacy });
  trace.event("pipeline_run_start", { scheduling: "agent", resumed: !!options.resumeRunId, previousTraceId, config_snapshot: saved.config.snapshot, config_fingerprint: saved.config.fingerprint, prompt_snapshot_sha256: prompts.fingerprint, policy: saved.policy, goal: saved.goal, available_modules: available });
  coordinator = new Coordinator(store, {
   record: report.event,
   inspectTaskData: configuration => inspectTaskData(task.taskId, configuration, projectPython()),
   // The file's entry is advice; stages run under what the agent declares.
   suggestedConfiguration: saved.config.taskConfigurations?.[task.taskId],
   branches: () => followUpBranches(statePath(PROJECT_ROOT, "solutions"), task.taskId),
   progress: print,
   // A budget-end refit is the harness's own hand-over: it outlives the deadline and has no model session to guard.
   start: (work, input) => startStageInvocation({ invocationId: work.id, stage: work.stage, input: { ...input, model: options.model }, config: saved.config, configPath: options.configPath, trace: trace!, prompts, setupSession: setup, optionOverrides: work.options,
    ...(work.origin === "budget_end" ? { reason: "budget_end_hand_over", signal: handOver.signal } : { reason: "orchestrator_decision", signal: controller.signal, executionGuard: coordinator!.guardFor(work.id) }) }),
   officialStatus: async () => { const accounting = await readSubmissionAccounting({ taskId: task.taskId, transport: submissionTransport(task.taskId), accountingRoot: statePath(PROJECT_ROOT, "submissions"), report, signal: controller.signal }); const s = accounting.officialStatus; return { triesUsed: s.triesUsed, reservedUnknown: accounting.reservedUnknown, effectiveTriesUsed: accounting.effectiveTriesUsed, unresolved: accounting.unresolved, results: s.attempts.map(a => ({ attemptId: a.id, status: a.state, ...(a.score === null ? {} : { score: a.score }) })) }; },
   recover: async (work, input) => {
    // Deterministic adapters reconcile their existing ledger/freeze with the same
    // durable invocation identity. submitRefit never repeats an uncertain POST.
    return reconcileOwnedInvocation(work, input, { config: saved.config, trace: trace!, prompts, setupSession: setup, signal: controller.signal, reason: "orchestrator_restart_reconciliation", optionOverrides: work.options });
   },
  });
  const allSetup = () => setup.check(setupChecks(["observability", "orchestrator", "model", "python", "task", "knowledge", ...available.flatMap(name => [...(getStage(name).setupRequirements ?? [])])], {
   telemetry: trace!.telemetry, taskId: task.taskId, model: options.model, configPath: options.configPath, prompts, submissionPolicy: saved.policy,
   // The decision agent declares the configuration; its tool validates the task files then.
   taskConfiguration: coordinator!.state.taskConfiguration?.configuration ?? saved.config.taskConfigurations?.[task.taskId], taskConfigurationDeclaredLater: true,
   candidateProducedUpstream: available.includes("solve"), refitTrainingRoot: (saved.config.effectiveOptions.refit as { trainingRoot?: string })?.trainingRoot,
  }), controller.signal, trace!.event);
  if (options.checkSetupOnly) { await allSetup(); stoppedBecause = "setup checks passed; no agents or stages executed"; outcome = "success"; return result(); }
  const remaining = saved.deadline - Date.now();
  if (remaining > 0) timer = setTimeout(() => { deadlineReached = true; controller.abort(); }, remaining); else deadlineReached = true;
  const recoverySetup = async () => {
   await setup.check(setupChecks(["observability", ...(saved.policy.authorized ? ["submission-recovery" as const] : [])], { telemetry: trace!.telemetry, taskId: task.taskId, prompts, submissionPolicy: saved.policy }), handOver.signal, trace!.event);
  };
  const loop = { deadlineReached: () => deadlineReached, userCancelled: () => !!options.signal?.aborted, report };
  let ended: Awaited<ReturnType<typeof runDecisionLoop>>;
  if (deadlineReached) {
   // A run resumed after its deadline only reconciles and hands over what exists.
   await recoverySetup(); if (options.resumeRunId) await coordinator.recover();
   ended = await runDecisionLoop(coordinator, { ...loop, runAgent: async () => { throw new Error("Deadline passed before the resume"); } });
  } else {
   // Read-only official/recovery access is checked before unrelated model probes.
   // Exhausted or already-achieved goals require no new provider session.
   const ready = await prepareDecisionLoop(coordinator, { resume: !!options.resumeRunId, allSetup, recoverySetup });
   if (!ready) { stoppedBecause = coordinator.state.reason ?? coordinator.state.status; outcome = coordinator.state.status === "finished" ? "success" : "failure"; return result(); }
   const knowledge = new TaskKnowledge({ root: statePath(PROJECT_ROOT, "knowledge"), origin: { taskId: task.taskId, datasetSha256: context.dataset.snapshot_sha256, pipelineRunId: saved.runId, stageInvocationId: saved.controlInvocationId } });
   ended = await runDecisionLoop(coordinator, { ...loop, runAgent: attempt => runDecisionAgent({ coordinator: coordinator!, prompts, report, taskDescription, taskFiles: listTaskDataFiles(task.taskId), knowledgeSummaries: knowledge.search(task.taskTitle.slice(0, 200), 6), model: options.model, signal: controller.signal, attempt }) });
  }
  await coordinator.settle();
  stoppedBecause = coordinator.state.reason ?? "agent finished";
  // A budget end without a hand-over is a failure, not a cancel by the caller.
  outcome = coordinator.state.status === "finished" ? "success" : coordinator.state.status === "cancelled" && !ended.budgetEnd ? "cancelled" : "failure";
  return result();
 } catch (error) {
  const cancelled = !!options.signal?.aborted;
  await coordinator?.stop(cancelled ? "Run cancelled" : deadlineReached ? "Persisted wall budget exhausted" : "Run failed; owned workers settled");
  stoppedBecause = error instanceof Error ? error.message : "Orchestrator run failed"; outcome = cancelled ? "cancelled" : "failure";
  trace?.event("orchestrator_error", { reason: stoppedBecause }); throw error;
 } finally {
  if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
  if (store && !options.checkSetupOnly) print({ kind: "run_ended", runId: store.state.runId, outcome, reason: stoppedBecause });
  trace?.event("pipeline_run_end", { outcome, stopped_because: stoppedBecause, revision: store?.state.revision });
  try { await trace?.close(); } finally { coordinator?.close(); if (!coordinator) store?.close(); releaseWorkspace(); }
  if (finalResult && trace) Object.assign(finalResult, delivery());
 }
 function delivery() { return { traceDegraded: trace!.degraded(), traceFailures: trace!.failures(), localTracePath: trace!.localPath, traceId: trace!.traceId, traceUrl: trace!.traceUrl }; }
 function result(): PipelineRunResult { return finalResult = { pipelineRunId: store!.state.runId, taskId: task.taskId, invocations: store!.state.works.flatMap(w => w.result ? [w.result] : []), outcome, stoppedBecause,
  ...delivery() }; }
}
