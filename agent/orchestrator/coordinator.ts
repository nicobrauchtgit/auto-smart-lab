import { randomUUID } from "node:crypto";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageInvocationHandle } from "../pipeline/executor.js";
import type { StageArtifact, StageInput, StageInvocation, StageName } from "../pipeline/types.js";
import { guidanceHash, type EvidenceReference, type StageFeedback } from "../pipeline/guidance.js";
import { StateStore, hash, type Action, type Counter, type OfficialResult, type RunState, type Work } from "./state.js";
import { parseTaskConfiguration, taskConfigurationHash, type TaskConfiguration } from "../pipeline/task_configuration.js";
export interface Mutation { actionId: string; expectedRevision: number; rationale: string }
export interface ConfigureRequest extends Mutation { configuration: unknown }
export interface StartRequest extends Mutation { stage: StageName; objective: string; artifactIds: string[]; guidance?: string; evidenceIds?: string[] }
export interface CoordinatorDependencies {
 start(work: Work, input: StageInput): StageInvocationHandle;
 /** Read-only aggregate remote attempts; module ledger remains upload authority. */
 officialStatus?(): Promise<{ triesUsed: number; reservedUnknown?: number; effectiveTriesUsed?: number; unresolved?: boolean; results?: OfficialResult[] }>;
 /** Only deterministic idempotent adapters may recover a physical invocation. */
 recover?(work: Work, input: StageInput): Promise<StageInvocation | undefined>;
 record?(kind: string, payload: Record<string, unknown>): void;
 /** Check the declared files against the task data; returns bounded facts, throws on mismatch. */
 inspectTaskData?(configuration: TaskConfiguration): unknown;
 /** The task's pipeline.config.json entry, offered while nothing is declared; never applied implicitly. */
 suggestedConfiguration?: TaskConfiguration;
}
function text(value: unknown, bytes: number): asserts value is string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > bytes) throw new Error("Missing or oversized text"); }
function terminal(w: Work) { return w.status === "terminal" || w.status === "interrupted"; }
export class Coordinator {
 private handles = new Map<string, StageInvocationHandle>();
 private pending = new Set<Promise<unknown>>();
 private waiters = new Set<() => void>();
 private failure?: unknown;
 private remoteUsed = 0;
 constructor(readonly store: StateStore, private readonly deps: CoordinatorDependencies) { this.remoteUsed = store.state.remoteTriesUsed; }
 get state() { return this.store.state; }
 private commit(kind: string, payload: Record<string, unknown>, update: (s: RunState) => void) {
  if (this.failure) throw new Error("Coordinator durability failed; no further effects are allowed");
  try { const state = this.store.transaction(kind, payload, update); this.deps.record?.(kind, { revision: state.revision, ...payload }); for (const wake of this.waiters) wake(); return state; }
  catch (error) { this.failure = error; for (const handle of this.handles.values()) handle.cancel(); throw error; }
 }
 private notice(s: RunState, kind: string, summary: Record<string, unknown>, id?: string) {
  s.cursor++; s.inbox.push({ cursor: s.cursor, kind, invocationId: id, summary });
  // Terminal changes are never coalesced away; budgets cap their total count.
  if (s.inbox.length > s.limits.maxNotifications) throw new Error("Notification capacity reached; acknowledge the inbox");
 }
 charge(counter: Counter) {
  const s = this.state, key = `max${counter[0].toUpperCase()}${counter.slice(1)}` as keyof RunState["limits"];
  if (s.status !== "running" || Date.now() >= s.deadline || s.counters[counter] >= s.limits[key]) throw new Error(`Controller ${counter}/wall budget exhausted`);
  this.commit("budget_reserved", { counter }, next => { next.counters[counter]++; });
 }
 readonly executionGuard = { beforeSession: () => this.charge("sessions"), beforeModelRequest: () => this.charge("modelRequests"), beforeToolCall: () => this.charge("toolCalls") };
 private inspectMutation(request: Mutation, kind: string): Action | undefined {
  text(request.actionId, 128); text(request.rationale, 2048);
  const s = this.state, prior = s.actions.find(a => a.id === request.actionId);
  // Expected revision is transport concurrency data, not the logical action payload.
  const { expectedRevision, ...payload } = request;
  const requestHash = hash({ kind, payload });
  if (prior) { if (prior.requestHash !== requestHash) throw new Error("Action ID conflict"); return prior; }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== s.revision) throw new Error(`Stale revision; current revision is ${s.revision}`);
  if (s.status !== "running" || Date.now() >= s.deadline) throw new Error("Run is terminal or wall budget expired");
  return undefined;
 }
 private action(request: Mutation, kind: string, receipt: Record<string, unknown>): Action {
  const { expectedRevision, ...payload } = request;
  return { id: request.actionId, kind, requestHash: hash({ kind, payload }), revision: this.state.revision + 1, receipt };
 }
 status(cursor?: number) {
  const s = this.state;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > s.cursor)) throw new Error("Invalid notification cursor");
  const notifications = s.inbox.filter(n => n.cursor > (cursor ?? s.acknowledgedCursor)).slice(0, 4);
  const status = { runId: s.runId, logicalOwner: s.controlInvocationId, revision: s.revision, status: s.status, reason: s.reason,
   goal: s.goal, availableModules: s.config.enabledStages.filter(name => name !== "submit" || s.policy.authorized), policy: s.policy,
   taskConfiguration: s.taskConfiguration ? { declared: true, sha256: s.taskConfiguration.sha256, configuration: s.taskConfiguration.configuration }
    : { declared: false, required: "Declare it with task_configure before starting a stage", ...(this.deps.suggestedConfiguration ? { suggested: this.deps.suggestedConfiguration } : {}) },
   budgets: { limits: s.limits, used: s.counters, deadline: s.deadline, triesUsed: this.remoteUsed, reservedUnknown: s.reservedUnknown, effectiveTriesUsed: this.remoteUsed + s.reservedUnknown, submissionsRemaining: Math.max(0, Math.min(3, s.policy.maxSubmissions) - this.remoteUsed - s.reservedUnknown) },
   works: s.works.slice(-4).map(w => ({ id: w.id, stage: w.stage, status: w.status, objective: w.objective, summary: w.summary })),
   // Keep the newest artifact of each kind available after large training
   // invocations; otherwise dozens of fold artifacts hide the research input
   // required by the next solver after an official feedback round.
   artifacts: [...new Map(s.artifacts.map(a => [a.kind, a])).values()].sort((a, b) => Number(requiredArtifact(b.kind)) - Number(requiredArtifact(a.kind))).slice(0, 16).map(a => ({ id: a.id, kind: a.kind, sha256: a.sha256, bytes: a.bytes, producer: a.producer })),
   bestOfficial: s.bestOfficial, officialResults: s.official.slice(-3), cursor: notifications.at(-1)?.cursor ?? (cursor ?? s.acknowledgedCursor), latestCursor: s.cursor, acknowledgedCursor: s.acknowledgedCursor,
   notifications, truncated: false };
  if (Buffer.byteLength(JSON.stringify(status)) > s.limits.maxSummaryBytes) {
   status.truncated = true;
   status.works = status.works.map(w => ({ ...w, summary: w.summary ? { outcome: w.summary.outcome, validation: w.summary.validation, detailRequired: true } : undefined }));
   status.notifications = status.notifications.map(n => ({ ...n, summary: { outcome: n.summary.outcome, detailRequired: true } }));
  }
  if (Buffer.byteLength(JSON.stringify(status)) > s.limits.maxSummaryBytes) throw new Error("Configured summary byte budget cannot contain mandatory controller state");
  return status;
 }
 async refreshOfficial() {
  if (!this.state.policy.authorized || !this.state.config.enabledStages.includes("submit") || !this.deps.officialStatus) return;
  const status = await this.deps.officialStatus();
  if (!Number.isInteger(status.triesUsed) || status.triesUsed < 0) throw new Error("Invalid remote attempt count");
  if (status.reservedUnknown !== undefined && (!Number.isInteger(status.reservedUnknown) || status.reservedUnknown < 0 || status.reservedUnknown > 3)) throw new Error("Invalid task-global unknown reservations");
  this.remoteUsed = Math.max(this.remoteUsed, status.triesUsed);
  this.commit("official_status", { triesUsed: this.remoteUsed }, s => {
   s.remoteTriesUsed = this.remoteUsed;
   if (status.reservedUnknown !== undefined) s.reservedUnknown = status.reservedUnknown;
   if (Number.isInteger(status.effectiveTriesUsed) && status.effectiveTriesUsed! > this.remoteUsed + s.reservedUnknown) s.reservedUnknown = status.effectiveTriesUsed! - this.remoteUsed;
   for (const result of status.results ?? []) {
    const index = s.official.findIndex(r => r.attemptId === result.attemptId);
    // Read-only polling can move a pending attempt to scored/rejected. Retain
    // controller provenance that the remote aggregate table cannot supply.
    if (index >= 0) s.official[index] = { ...s.official[index], ...result };
    else s.official.push(result);
   }
   s.bestOfficial = s.official.filter(r => typeof r.score === "number").sort((a,b) => b.score! - a.score!)[0];
   if (status.unresolved || s.reservedUnknown > 0) { s.status = "blocked"; s.reason = "Task-global submission accounting has pending or unknown intents; reconcile the existing ledger before any new model/stage effects"; }
  });
 }
 finishIfOfficialComplete(): boolean {
  const s = this.state;
  if (s.status !== "running" || s.works.some(w => !terminal(w))) return s.status !== "running";
  if (s.policy.authorized && ((s.bestOfficial?.score !== undefined && s.bestOfficial.score >= s.goal.targetScore) || this.remoteUsed >= s.policy.maxSubmissions)) {
   this.commit("official_objective_terminal", {}, next => { next.status = "finished"; next.reason = s.bestOfficial?.score !== undefined && s.bestOfficial.score >= s.goal.targetScore ? "Official target already reached" : "Total task submission cap exhausted; official best retained"; }); return true;
  }
  return false;
 }
 private selected(ids: string[], verify = true): StageArtifact[] {
  if (!Array.isArray(ids) || ids.length > 32 || new Set(ids).size !== ids.length) throw new Error("Invalid artifact IDs");
  return ids.map(id => { const a = this.state.artifacts.find(a => a.id === id); if (!a) throw new Error("Unknown trusted artifact ID");
   if (verify && (statSync(a.path).size > 64 * 1024 * 1024 || hash(readFileSync(a.path)) !== a.sha256)) throw new Error("Upstream artifact changed since validation");
   const { id: _, snapshotPath: __, producer: ___, ...artifact } = a; return artifact; });
 }
 /**
  * Declare the harness parts for this task. Validated for consistency and
  * against the task's files before it is accepted; every later stage runs
  * under it. A re-declaration applies to new invocations only.
  */
 configure(request: ConfigureRequest) {
  const prior = this.inspectMutation(request, "task_configure"); if (prior) return prior.receipt;
  if (this.state.works.some(w => !terminal(w))) throw new Error("Settle or cancel owned work before changing the task configuration");
  const configuration = parseTaskConfiguration(request.configuration);
  const facts = this.deps.inspectTaskData?.(configuration);
  const sha256 = taskConfigurationHash(configuration);
  const replaced = this.state.taskConfiguration?.sha256;
  const receipt = { accepted: true, sha256, data: facts ?? null,
   ...(replaced && replaced !== sha256 ? { replaced, note: "New invocations use this configuration; champions measured under the previous one cannot be compared or refit under it" } : {}) };
  this.commit("task_configured", { actionId: request.actionId, sha256, configuration }, s => {
   s.actions.push(this.action(request, "task_configure", receipt));
   s.taskConfiguration = { configuration, sha256, actionId: request.actionId, revision: s.revision + 1 };
  });
  return { ...receipt, revision: this.state.revision };
 }
 start(request: StartRequest) {
  const prior = this.inspectMutation(request, "stage_start"); if (prior) return prior.receipt;
  const s = this.state; text(request.objective, 2048);
  if (!s.config.enabledStages.includes(request.stage)) throw new Error("Stage unavailable");
  if (!s.taskConfiguration) throw new Error("Declare the task configuration with task_configure before starting a stage");
  if (s.works.some(w => !terminal(w))) throw new Error("One mutating stage/workspace at a time");
  if (s.works.some(w => w.stage === "solve" && w.status === "interrupted" && (w.summary as any)?.trainingRecoveryRequired) && request.stage !== "solve") throw new Error("Reconcile lost solver's owned training through a new solve invocation before other workspace work");
  if (s.counters.stages >= s.limits.maxStages) throw new Error("Stage budget exhausted");
  const upstream = this.selected(request.artifactIds);
  for (const artifact of upstream) {
   const producer = s.works.find(w => w.id === artifact.provenance?.invocationId);
   if (producer?.result?.outcome !== "success" || producer.result.validation?.valid !== true) throw new Error("Upstream artifact did not pass its producer's authoritative validation");
  }
  if (request.stage === "submit") {
   if (!s.policy.authorized || this.remoteUsed + s.reservedUnknown >= s.policy.maxSubmissions || this.remoteUsed + s.reservedUnknown >= 3) throw new Error("Submission is not authorized or the three-attempt cap is exhausted");
   if (s.reservedUnknown > 0) throw new Error("Unknown submission reservation requires reconciliation before another upload");
   if (s.bestOfficial?.score !== undefined && s.bestOfficial.score >= s.goal.targetScore) throw new Error("Target already reached");
   const frozen = upstream.filter(a => a.kind === "terminal_refit_result");
   if (frozen.length !== 1) throw new Error("Submission requires one validated terminal refit");
   if (s.works.some(w => w.stage === "submit" && w.upstream.some(id => request.artifactIds.includes(id)))) throw new Error("Identical frozen bundle already attempted; inspect its receipt");
  }
  if (request.guidance !== undefined) text(request.guidance, 8192);
  if (request.guidance !== undefined && !["research", "solve", "evaluate"].includes(request.stage)) throw new Error("Deterministic stages do not accept model guidance");
  const evidence = this.selected(request.evidenceIds ?? []).map(a => a.provenance!);
  const id = randomUUID();
  const note = request.guidance === undefined ? undefined : { id: `${request.actionId}:guidance`, version: 1, stage: request.stage, taskId: s.taskId, objective: request.objective, content: request.guidance, author: { name: "orchestrator", logicalSessionId: s.controlInvocationId }, evidence };
  let options: unknown;
  let trials = 0;
  if (request.stage === "solve") {
   const configured = s.config.effectiveOptions.solve as { maxIterations: number };
   trials = Math.min(configured.maxIterations, s.limits.maxTrials - s.counters.trials);
   if (trials < 1) throw new Error("Global trial budget exhausted");
   options = { maxIterations: trials };
  }
  const retry = s.works.filter(w => w.stage === request.stage && w.result?.outcome !== "success").length > 0;
  if (retry && s.counters.retries >= s.limits.maxRetries) throw new Error("Retry budget exhausted");
  const work: Work = { id, stage: request.stage, actionId: request.actionId, objective: request.objective, upstream: request.artifactIds, status: "reserved", guidance: note ? { ...note, contentSha256: guidanceHash(note) } : undefined, options, taskConfiguration: s.taskConfiguration.configuration };
  const receipt = { invocationId: id, accepted: true };
  this.commit("action_accepted", { ...request, invocationId: id }, next => {
   next.actions.push(this.action(request, "stage_start", receipt)); next.works.push(work); next.counters.stages++; next.counters.trials += trials; if (retry) next.counters.retries++;
  });
  this.launch(work); return { ...receipt, revision: this.state.revision };
 }
 private input(work: Work, reconciliation = false): StageInput {
  const s = this.state;
  // Ledger reconciliation authenticates the durable submitted bundle itself.
  // Original source/refit paths may have disappeared after the one POST; they
  // must not prevent resolving that intent or induce a fallback upload.
  const metadataOnly = reconciliation && work.stage === "submit";
  return { taskId: s.taskId, taskConfiguration: work.taskConfiguration ?? s.taskConfiguration?.configuration, guidance: metadataOnly ? undefined : work.guidance, upstream: this.selected(work.upstream, !metadataOnly), evidenceCatalog: metadataOnly ? [] : this.selected(work.guidance?.evidence.map(ref => ref.artifactId) ?? []), submissionPolicy: { ...s.policy, controllerInvocationId: work.stage === "submit" ? work.id : s.controlInvocationId } };
 }
 private launch(work: Work) {
  this.commit("stage_dispatched", { invocationId: work.id }, s => { s.works.find(w => w.id === work.id)!.status = "active"; });
  try {
   const handle = this.deps.start(work, this.input(work));
   if (handle.invocationId !== work.id) { handle.cancel(); throw new Error("Executor invocation reservation mismatch"); }
   this.handles.set(work.id, handle);
   const pending = handle.result.then(result => this.complete(work.id, result), error => this.failWork(work.id, error)).catch(error => { this.failure = error; for (const h of this.handles.values()) h.cancel(); }).finally(() => { this.handles.delete(work.id); this.pending.delete(pending); for (const wake of this.waiters) wake(); });
   this.pending.add(pending);
  } catch (error) { this.failWork(work.id, error); }
 }
 private failWork(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Stage dispatch failed";
  this.commit("stage_dispatch_failed", { invocationId: id }, s => { const w = s.works.find(w => w.id === id)!; w.status = "terminal"; w.summary = { outcome: "failure", error: message.slice(0, 1000) }; this.notice(s, "stage_failure", w.summary, id); });
 }
 private complete(id: string, result: StageInvocation) {
  if (result.invocationId !== id) throw new Error("Stage result identity mismatch");
  const directory = join(this.store.directory, "artifacts"); mkdirSync(directory, { recursive: true });
  const full = JSON.stringify(result), fullHash = hash(full), resultPath = join(directory, `${fullHash}.json`);
  if (!statExists(resultPath)) writeFileSync(resultPath, full, { flag: "wx", flush: true });
  const artifacts: RunState["artifacts"] = [];
  for (const artifact of result.artifacts) {
   if (!artifact.provenance || !artifact.sha256) continue;
   const size = statSync(artifact.path).size; if (size > 64 * 1024 * 1024) continue;
   const bytes = readFileSync(artifact.path); if (hash(bytes) !== artifact.sha256) throw new Error("Completed artifact hash mismatch");
   const snapshotPath = join(directory, artifact.sha256);
   if (!statExists(snapshotPath)) writeFileSync(snapshotPath, bytes, { flag: "wx", flush: true });
   artifacts.push({ ...artifact, bytes: size, id: artifact.provenance.artifactId, producer: id, snapshotPath });
  }
  const errors = result.validation?.errors ?? [];
  const measurements = boundedSummary(result.summary ?? {}, 4096);
  const summary = { outcome: result.outcome, validation: result.validation ? { valid: result.validation.valid, errors: errors.slice(0, 16).map(e => e.slice(0, 512)), totalErrors: errors.length } : { valid: false, errors: ["Stage returned no artifact validation"] }, error: result.error?.slice(0, 1024), measurements, resultArtifact: { path: resultPath, sha256: fullHash }, truncated: errors.length > 16 || errors.some(e => e.length > 512), artifactIds: artifacts.map(a => a.id) };
  const submission = result.summary as Record<string, any> | undefined;
  if (result.stage === "submit" && Number.isInteger(submission?.triesUsed)) this.remoteUsed = Math.max(this.remoteUsed, submission!.triesUsed);
  this.commit("stage_completed", { invocationId: id, fullHash }, s => {
   s.remoteTriesUsed = this.remoteUsed;
   if (result.stage === "submit") {
    const reserved = submission?.reservedUnknown;
    const effective = submission?.effectiveTriesUsed;
    s.reservedUnknown = Number.isInteger(reserved) && reserved >= 0 ? reserved : Number.isInteger(effective) && effective >= this.remoteUsed ? effective - this.remoteUsed : s.reservedUnknown;
    if (Number.isInteger(effective) && effective > this.remoteUsed + s.reservedUnknown) s.reservedUnknown = effective - this.remoteUsed;
   }
   const work = s.works.find(w => w.id === id)!; work.status = "terminal"; work.result = { ...result, artifacts: [], summary: undefined }; work.summary = summary;
   if (work.stage === "solve") for (const old of s.works.filter(w => w.stage === "solve" && w.status === "interrupted")) { if (old.summary) old.summary.trainingRecoveryRequired = false; }
   s.artifacts.push(...artifacts.filter(a => !s.artifacts.some(old => old.id === a.id)));
   if (result.stage === "submit" && submission?.attemptId) {
    const score = submission.officialScore;
    const official: OfficialResult = { attemptId: submission.attemptId, status: submission.state ?? result.outcome, artifactId: artifacts.find(a => /receipt/.test(a.kind))?.id,
     ...(typeof score === "number" && score >= 0 && score <= 1 ? { score } : {}), candidateId: submission.bundleId };
    const prior = s.official.findIndex(r => r.attemptId === official.attemptId); if (prior >= 0) s.official[prior] = official; else s.official.push(official);
    s.bestOfficial = s.official.filter(r => r.score !== undefined).sort((a,b) => b.score! - a.score!)[0];
   }
   this.notice(s, "stage_terminal", summary, id);
   if (result.stage === "submit" && (submission?.state === "unknown" || submission?.state === "pending" || submission?.reservedUnknown > 0)) { s.status = "blocked"; s.reason = "Submission outcome is pending or unknown; reconcile the same durable invocation without another upload"; }
  });
 }
 stageStatus(id: string) { const w = this.state.works.find(w => w.id === id); if (!w) throw new Error("Unknown invocation"); return { invocationId: id, stage: w.stage, status: w.status, summary: boundedSummary(w.summary ?? {}, this.state.limits.maxSummaryBytes - 1024), revision: this.state.revision }; }
 async feedback(request: Mutation & { invocationId: string; message: string; evidenceIds: string[] }) {
  const prior = this.inspectMutation(request, "stage_feedback"); if (prior) return prior.receipt;
  text(request.message, 8192); const work = this.state.works.find(w => w.id === request.invocationId), handle = this.handles.get(request.invocationId);
  if (!work || !handle || terminal(work)) throw new Error("Invocation has no live feedback receiver; start a new invocation");
  if (!["research", "solve", "evaluate"].includes(work.stage)) throw new Error("Feedback unsupported for deterministic stage");
  const evidence: EvidenceReference[] = this.selected(request.evidenceIds).map(a => a.provenance!);
  const note = { id: request.actionId, stage: work.stage, taskId: this.state.taskId, content: request.message, evidence, author: { name: "orchestrator", logicalSessionId: this.state.controlInvocationId } };
  const receipt = { accepted: true, deliveryId: request.actionId, state: "pending" };
  this.commit("feedback_accepted", { ...request }, s => { s.actions.push(this.action(request, "stage_feedback", receipt)); });
  const delivered = await handle.feedback({ ...note, contentSha256: guidanceHash(note) } as StageFeedback);
  this.commit("feedback_receipt", { receipt: delivered }, s => { s.actions.find(a => a.id === request.actionId)!.receipt = { ...delivered }; });
  return delivered;
 }
 cancel(request: Mutation & { invocationId: string }) {
  const prior = this.inspectMutation(request, "stage_cancel"); if (prior) return prior.receipt;
  const handle = this.handles.get(request.invocationId); if (!handle) throw new Error("No owned live invocation to cancel");
  const receipt = { cancellationRequested: true, invocationId: request.invocationId };
  this.commit("cancel_requested", { ...request }, s => { s.actions.push(this.action(request, "stage_cancel", receipt)); });
  handle.cancel(); return receipt;
 }
 inspect(id: string, offset = 0) {
  const s = this.state, artifact = s.artifacts.find(a => a.id === id); if (!artifact) throw new Error("Unknown trusted artifact");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > (artifact.bytes ?? 0)) throw new Error("Invalid detail cursor");
  const bytes = readFileSync(artifact.snapshotPath); if (hash(bytes) !== artifact.sha256) throw new Error("Artifact snapshot corrupted");
  // Predictions, labels, models and raw dataset rows never enter controller context.
  if (!/^(research_document|research_context|training_trial_result|training_selected_result|evaluation_report|terminal_refit_result|submission_receipt)$/.test(artifact.kind)) throw new Error("Artifact kind is not available through bounded controller detail");
  const content = bytes.toString("utf8");
  if (artifact.kind !== "research_document") {
   const parsed = JSON.parse(content);
   const safe = artifact.kind === "research_context" ? { task: parsed.task, limits: parsed.limits, dataset: { snapshot_sha256: parsed.dataset?.snapshot_sha256, total_files: parsed.dataset?.total_files } } : parsed;
   return { id, provenance: artifact.provenance, section: "summary", ...boundedSummary(safe, s.limits.maxDetailBytes) };
  }
  const page = bytes.subarray(offset, offset + s.limits.maxDetailBytes);
  return { id, provenance: artifact.provenance, content: page.toString("utf8"), nextOffset: offset + page.length < bytes.length ? offset + page.length : null, truncated: page.length < bytes.length };
 }
 async wait(cursor: number, timeoutMs = 60000, signal?: AbortSignal) {
  this.status(cursor); const s = this.state;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > s.limits.maxWaitMs) throw new Error("Invalid bounded wait timeout");
  if (cursor > s.acknowledgedCursor) this.commit("notifications_acknowledged", { cursor }, next => { next.acknowledgedCursor = cursor; next.inbox = next.inbox.filter(n => n.cursor > cursor); });
  const end = Math.min(Date.now() + timeoutMs, s.deadline);
  while (this.state.cursor <= cursor && this.state.works.some(w => !terminal(w)) && Date.now() < end) {
   signal?.throwIfAborted();
   await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { done(); reject(new Error("Wait cancelled")); };
    const timer = setTimeout(done, Math.max(0, end - Date.now())); this.waiters.add(done); signal?.addEventListener("abort", abort, { once: true });
   });
  }
  if (this.failure) throw new Error("Coordinator durability failed during stage work");
  return this.status(cursor);
 }
 finish(request: Mutation & { outcome: "finished" | "blocked" }) {
  const prior = this.inspectMutation(request, "pipeline_finish"); if (prior) return prior.receipt;
  if (!["finished", "blocked"].includes(request.outcome)) throw new Error("Invalid final outcome");
  if (this.state.works.some(w => !terminal(w))) throw new Error("Settle or cancel owned work before finishing");
  const receipt = { status: request.outcome, reason: request.rationale };
  this.commit("pipeline_finished", { ...request }, s => { s.actions.push(this.action(request, "pipeline_finish", receipt)); s.status = request.outcome; s.reason = request.rationale; }); return receipt;
 }
 async recover() {
  if (this.state.status === "blocked" && (this.state.reason?.startsWith("Task-global submission accounting") || this.state.works.some(w => unresolvedSubmission(w) || w.status === "uncertain"))) this.commit("explicit_reconciliation_resume", {}, s => { s.status = "running"; s.reason = undefined; });
  await this.refreshOfficial();
  for (const work of this.state.works.filter(w => !terminal(w) || unresolvedSubmission(w))) {
   if (["research", "solve", "evaluate"].includes(work.stage)) {
    // Lost Pi session cannot be reattached. Live training is recovered by the next
    // solver's existing harness root ownership path; no worker is duplicated here.
    this.commit("agent_invocation_interrupted", { invocationId: work.id }, s => { const w = s.works.find(w => w.id === work.id)!; w.status = "interrupted"; w.summary = { outcome: "interrupted", trainingRecoveryRequired: w.stage === "solve", reason: "Host restarted; in-memory agent session lost. Existing training requires harness reconciliation before the next fit." }; this.notice(s, "stage_interrupted", w.summary, w.id); });
   } else {
    this.commit("recovery_uncertain", { invocationId: work.id }, s => { s.works.find(w => w.id === work.id)!.status = "uncertain"; });
    const result = await this.deps.recover?.(work, this.input(work, true));
    if (result && (work.stage !== "submit" || ["scored", "rejected", "disabled", "pending", "unknown"].includes(String(result.summary?.state)))) this.complete(work.id, result);
    else this.commit("recovery_blocked", { invocationId: work.id }, s => { s.status = "blocked"; s.reason = "Deterministic work has an uncertain outcome; reconcile its durable worker/submission ledger before new effects"; });
   }
  }
  // A feedback acceptance without a durable delivery receipt cannot be replayed.
  for (const a of this.state.actions.filter(a => a.kind === "stage_feedback" && a.receipt.state === "pending")) this.commit("feedback_interrupted", { actionId: a.id }, s => { s.actions.find(n => n.id === a.id)!.receipt = { ...a.receipt, state: "interrupted", reason: "Host restarted before delivery receipt" }; });
 }
 async stop(reason: string) {
  for (const h of this.handles.values()) h.cancel();
  await Promise.allSettled([...this.pending]);
  if (!this.failure && this.state.status === "running") this.commit("pipeline_cancelled", { reason }, s => { s.status = "cancelled"; s.reason = reason; });
 }
 async settle() { await Promise.allSettled([...this.pending]); if (this.failure) throw this.failure; }
 close() { this.store.close(); }
}
function unresolvedSubmission(work: Work): boolean {
 const content = (work.summary?.measurements as any)?.content;
 return work.stage === "submit" && (work.status === "uncertain" || ["pending", "unknown"].includes(content?.state) || content?.reservedUnknown > 0);
}
function requiredArtifact(kind: string) { return ["research_document", "training_selected_result", "evaluation_report", "terminal_refit_result", "submission_receipt"].includes(kind); }
function statExists(path: string) { try { statSync(path); return true; } catch { return false; } }
export function boundedSummary(value: unknown, maxBytes: number): Record<string, unknown> {
 function bound(v: any, depth = 0): any { if (depth > 4) return { omitted: true }; if (typeof v === "string") return v.length > 512 ? `${v.slice(0, 512)}…` : v; if (Array.isArray(v)) return v.slice(0, 12).map(x => bound(x, depth + 1)); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 24).filter(([k]) => !/prediction|label|target|row|curve|sealed.*score|model.pkl/i.test(k)).map(([k, x]) => [k, bound(x, depth + 1)])); return v; }
 const content = bound(value);
 if (Buffer.byteLength(JSON.stringify(content)) <= maxBytes) return { content, truncated: hash(content) !== hash(value) };
 return { content: { detailRequired: true }, truncated: true, sha256: hash(value), bytes: Buffer.byteLength(JSON.stringify(value)) };
}
