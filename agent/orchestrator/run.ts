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
import { runDecisionAgent } from "./session.js";
import type { PipelineRunResult, StageInput } from "../pipeline/types.js";
export interface OrchestratorOptions {
 telemetry?: import("../telemetry/runtime.js").TelemetryOptions;
 taskId: string; targetScore?: number; maxSubmissions?: number; noSubmit?: boolean; checkSetupOnly?: boolean;
 model?: string; configPath?: string; runsDir?: string; resumeRunId?: string; limits?: Partial<Limits>; signal?: AbortSignal;
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
export async function runOrchestrator(options: OrchestratorOptions): Promise<PipelineRunResult> {
 const task = resolveTask({ taskId: options.taskId });
 const runsDir = options.runsDir ?? join(PROJECT_ROOT, "runs");
 if (options.resumeRunId && !/^[A-Za-z0-9_-]{1,128}$/.test(options.resumeRunId)) throw new Error("Invalid resume run ID");
 const releaseWorkspace = claimWorkspace(join(runsDir, task.taskId, "orchestrator-ownership"));
 let store: StateStore | undefined, coordinator: Coordinator | undefined, trace: Awaited<ReturnType<typeof createPipelineTrace>> | undefined;
 const controller = new AbortController();
 const cancel = () => controller.abort(); options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
 let timer: ReturnType<typeof setTimeout> | undefined;
 let finalResult: PipelineRunResult | undefined;
 let stoppedBecause = "", outcome: PipelineRunResult["outcome"] = "failure";
 try {
  const { resolved: config } = await loadResolvedPipelineConfig(options.configPath);
  // The task's own data, downloaded only if missing, before its dataset fingerprint is taken.
  const taskData = await ensureTaskData(task.taskId, { signal: controller.signal });
  const snapshot = loadPromptSnapshot(), runId = options.resumeRunId ?? randomUUID();
  const { context } = buildResearchContext(task.taskId);
  const taskDescription = [boundedFile(join(task.taskDir, "prompt.md")), ...(existsSync(join(dirname(task.taskDir), "unit-intro.md")) ? [boundedFile(join(dirname(task.taskDir), "unit-intro.md"), 16000)] : [])].join("\n\n");
  const taskFingerprint = hash({ taskId: task.taskId, taskDescription, dataset: context.dataset.snapshot_sha256 });
  store = new StateStore(join(runsDir, task.taskId, "pipeline", runId), options.resumeRunId ? undefined : initialState({ taskId: task.taskId, taskFingerprint, config, promptTemplates: snapshot.serialize(), promptFingerprint: snapshot.fingerprint,
   authorized: options.noSubmit !== true && options.maxSubmissions !== 0 && config.enabledStages.includes("submit"), maxSubmissions: options.maxSubmissions, targetScore: options.targetScore, limits: options.limits, runId }));
  const saved = store.state;
  if (saved.taskFingerprint !== taskFingerprint || saved.config.fingerprint !== config.fingerprint) throw new Error("Task/config changed since this run; refusing resumed effects");
  if (options.resumeRunId && ((options.targetScore !== undefined && options.targetScore !== saved.goal.targetScore) || (options.maxSubmissions !== undefined && options.maxSubmissions !== saved.policy.maxSubmissions) || (options.noSubmit === true && saved.policy.authorized))) throw new Error("Resume policy is immutable; start a separate no-submit run instead");
  const prompts = restorePromptSnapshot(saved.promptTemplates);
  if (prompts.fingerprint !== saved.promptFingerprint) throw new Error("Persisted prompt fingerprint mismatch");
  trace = await createPipelineTrace({ taskId: task.taskId, pipelineRunId: saved.runId, runsDir, telemetry: options.telemetry });
  const previousTraceId = [...saved.journal].reverse().find(entry => entry.kind === "telemetry_execution_started")?.payload.traceId;
  store.transaction("telemetry_execution_started", { traceId: trace.traceId, previousTraceId: previousTraceId ?? null, executionId: trace.telemetry.executionId }, () => {});
  const report = trace.stage("orchestrator", saved.controlInvocationId);
  const setup = new SetupSession();
  const available = saved.config.enabledStages.filter(name => name !== "submit" || saved.policy.authorized);
  trace.event("task_data_ready", { downloaded: taskData.downloaded, present: taskData.present, legacy: taskData.legacy });
  trace.event("pipeline_run_start", { scheduling: "agent", resumed: !!options.resumeRunId, previousTraceId, config_snapshot: saved.config.snapshot, config_fingerprint: saved.config.fingerprint, prompt_snapshot_sha256: prompts.fingerprint, policy: saved.policy, goal: saved.goal, available_modules: available });
  coordinator = new Coordinator(store, {
   record: report.event,
   inspectTaskData: configuration => inspectTaskData(task.taskId, configuration, projectPython()),
   // The file's entry is advice; stages run under what the agent declares.
   suggestedConfiguration: saved.config.taskConfigurations?.[task.taskId],
   start: (work, input) => startStageInvocation({ invocationId: work.id, stage: work.stage, input: { ...input, model: options.model }, config: saved.config, configPath: options.configPath, trace: trace!, prompts, setupSession: setup, optionOverrides: work.options, reason: "orchestrator_decision", signal: controller.signal, executionGuard: coordinator!.executionGuard }),
   officialStatus: async () => { const accounting = await readSubmissionAccounting({ taskId: task.taskId, transport: submissionTransport(task.taskId), accountingRoot: join(PROJECT_ROOT, "runs/submissions"), report, signal: controller.signal }); const s = accounting.officialStatus; return { triesUsed: s.triesUsed, reservedUnknown: accounting.reservedUnknown, effectiveTriesUsed: accounting.effectiveTriesUsed, unresolved: accounting.unresolved, results: s.attempts.map(a => ({ attemptId: a.id, status: a.state, ...(a.score === null ? {} : { score: a.score }) })) }; },
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
  const remaining = saved.deadline - Date.now(); if (remaining <= 0) throw new Error("Persisted wall budget exhausted");
  timer = setTimeout(cancel, remaining);
  // Read-only official/recovery access is checked before unrelated model probes.
  // Exhausted or already-achieved goals require no new provider session.
  const ready = await prepareDecisionLoop(coordinator, { resume: !!options.resumeRunId, allSetup, recoverySetup: async () => {
   await setup.check(setupChecks(["observability", ...(saved.policy.authorized ? ["submission-recovery" as const] : [])], { telemetry: trace!.telemetry, taskId: task.taskId, prompts, submissionPolicy: saved.policy }), controller.signal, trace!.event);
  } });
  if (!ready) { stoppedBecause = coordinator.state.reason ?? coordinator.state.status; outcome = coordinator.state.status === "finished" ? "success" : "failure"; return result(); }
  const knowledge = new TaskKnowledge({ root: join(PROJECT_ROOT, "knowledge"), origin: { taskId: task.taskId, datasetSha256: context.dataset.snapshot_sha256, pipelineRunId: saved.runId, stageInvocationId: saved.controlInvocationId } });
  let attempt = coordinator.state.counters.sessions + 1;
  for (;;) {
   controller.signal.throwIfAborted();
   report.event("agent_attempt_start", { attempt, role: "orchestrator" });
   try {
    await runDecisionAgent({ coordinator, prompts, report, taskDescription, taskFiles: listTaskDataFiles(task.taskId), knowledgeSummaries: knowledge.search(task.taskTitle.slice(0, 200), 6), model: options.model, signal: controller.signal, attempt });
    if (coordinator.state.status === "running") {
     await coordinator.stop("Decision agent ended without a controller finish; owned work was cancelled and settled");
    }
    break;
   } catch (error) {
    if (coordinator.state.status !== "running") break;
    controller.signal.throwIfAborted();
    coordinator.charge("retries");
    report.event("orchestrator_session_restart", { attempt, reason: "Physical session failed; durable coordinator and owned work retained" }); attempt++;
   } finally { report.event("agent_attempt_end", { attempt, role: "orchestrator", revision: coordinator.state.revision }); }
  }
  await coordinator.settle();
  stoppedBecause = coordinator.state.reason ?? "agent finished";
  outcome = coordinator.state.status === "finished" ? "success" : coordinator.state.status === "cancelled" ? "cancelled" : "failure";
  return result();
 } catch (error) {
  await coordinator?.stop(controller.signal.aborted ? "Run cancelled or persisted wall budget exhausted" : "Run failed; owned workers settled");
  stoppedBecause = error instanceof Error ? error.message : "Orchestrator run failed"; outcome = controller.signal.aborted ? "cancelled" : "failure";
  trace?.event("orchestrator_error", { reason: stoppedBecause }); throw error;
 } finally {
  if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
  trace?.event("pipeline_run_end", { outcome, stopped_because: stoppedBecause, revision: store?.state.revision });
  try { await trace?.close(); } finally { coordinator?.close(); if (!coordinator) store?.close(); releaseWorkspace(); }
  if (finalResult && trace) Object.assign(finalResult, delivery());
 }
 function delivery() { return { traceDegraded: trace!.degraded(), traceFailures: trace!.failures(), localTracePath: trace!.localPath, traceId: trace!.traceId, traceUrl: trace!.traceUrl }; }
 function result(): PipelineRunResult { return finalResult = { pipelineRunId: store!.state.runId, taskId: task.taskId, invocations: store!.state.works.flatMap(w => w.result ? [w.result] : []), outcome, stoppedBecause,
  ...delivery() }; }
}
