/** Authoritative transactions include the journal, so acceptance and state cannot tear apart. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, claimWorkspace } from "../experiments/ownership.js";
import type { ResolvedPipelineConfig } from "../pipeline/config.js";
import type { StageArtifact, StageInvocation, StageName, StageInput } from "../pipeline/types.js";
import type { StageGuidance } from "../pipeline/guidance.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { parseTaskConfiguration, taskConfigurationHash, type TaskConfiguration } from "../pipeline/task_configuration.js";
export const hash = (value: unknown): string => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export type Limits = typeof HARNESS_CONFIG.orchestrator;
export type Counter = "sessions" | "modelRequests" | "toolCalls" | "stages" | "trials" | "retries";
export interface CatalogArtifact extends StageArtifact { id: string; snapshotPath: string; producer: string }
export interface Work { id: string; stage: StageName; actionId: string; objective: string; upstream: string[]; status: "reserved" | "active" | "interrupted" | "uncertain" | "terminal"; guidance?: StageGuidance; options?: unknown; result?: StageInvocation; summary?: Record<string, unknown>;
 /** The configuration this invocation ran under; recovery reuses it even after a re-declaration. */
 taskConfiguration?: TaskConfiguration }
/** The controller's declared harness parts for this task. */
export interface DeclaredConfiguration { configuration: TaskConfiguration; sha256: string; actionId: string; revision: number }
export interface Action { id: string; requestHash: string; kind: string; revision: number; receipt: Record<string, unknown> }
export interface Notification { cursor: number; kind: string; invocationId?: string; summary: Record<string, unknown> }
export interface OfficialResult { attemptId: string; score?: number; candidateId?: string; artifactId?: string; status: string }
export interface RunState {
 schemaVersion: 1; runId: string; controlInvocationId: string; taskId: string; taskFingerprint: string;
 config: ResolvedPipelineConfig; promptTemplates: Record<string, string>; promptFingerprint: string;
 policy: NonNullable<StageInput["submissionPolicy"]>; goal: { objective: "maximize_official_score"; targetScore: number };
 startedAt: number; deadline: number; limits: Limits; counters: Record<Counter, number>; revision: number;
 status: "running" | "finished" | "blocked" | "cancelled"; reason?: string;
 works: Work[]; actions: Action[]; artifacts: CatalogArtifact[]; official: OfficialResult[]; bestOfficial?: OfficialResult;
 taskConfiguration?: DeclaredConfiguration;
 remoteTriesUsed: number; reservedUnknown: number; cursor: number; acknowledgedCursor: number; inbox: Notification[]; journal: { revision: number; at: number; kind: string; payload: Record<string, unknown> }[];
}
function validate(s: RunState): void {
 if (!s || s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !/^[a-f0-9]{64}$/.test(s.taskFingerprint) || !s.runId || !s.controlInvocationId || !s.taskId) throw new Error("Invalid coordinator identity/revision");
 if (!s.policy || s.policy.version !== 1 || typeof s.policy.authorized !== "boolean" || !Number.isInteger(s.policy.maxSubmissions) || s.policy.maxSubmissions < 0 || s.policy.maxSubmissions > 3 || s.policy.pipelineRunId !== s.runId || s.policy.controllerInvocationId !== s.controlInvocationId) throw new Error("Invalid immutable submission policy");
 if (s.goal?.objective !== "maximize_official_score" || !Number.isFinite(s.goal.targetScore) || s.goal.targetScore < 0 || s.goal.targetScore > 1) throw new Error("Invalid goal");
 if (!Array.isArray(s.works) || !Array.isArray(s.actions) || !Array.isArray(s.artifacts) || !Array.isArray(s.official) || !Array.isArray(s.journal) || !Array.isArray(s.inbox) || !["running", "finished", "blocked", "cancelled"].includes(s.status)) throw new Error("Invalid coordinator collections");
 for (const [key, value] of Object.entries(s.limits)) if (!Number.isSafeInteger(value) || value < 1 || value > HARNESS_CONFIG.orchestrator[key as keyof Limits]) throw new Error("Invalid or increased persisted budget");
 if (Object.keys(s.limits).length !== Object.keys(HARNESS_CONFIG.orchestrator).length || !Number.isSafeInteger(s.startedAt) || s.deadline !== s.startedAt + s.limits.maxWallMs) throw new Error("Invalid deadline/budgets");
 for (const key of ["sessions", "modelRequests", "toolCalls", "stages", "trials", "retries"] as const) if (!Number.isSafeInteger(s.counters[key]) || s.counters[key] < 0 || s.counters[key] > s.limits[`max${key[0].toUpperCase()}${key.slice(1)}` as keyof Limits]) throw new Error("Invalid budget counter");
 if (s.journal.length < s.revision || s.journal.some((entry, i) => entry.revision < (s.journal[i - 1]?.revision ?? 0) || entry.revision > (s.journal[i - 1]?.revision ?? 0) + 1) || (s.journal.at(-1)?.revision ?? 0) !== s.revision) throw new Error("Journal revision mismatch");
 if (new Set(s.actions.map(a => a.id)).size !== s.actions.length || new Set(s.works.map(w => w.id)).size !== s.works.length || new Set(s.artifacts.map(a => a.id)).size !== s.artifacts.length) throw new Error("Duplicate coordinator identity");
 if (s.works.filter(w => ["reserved", "active", "uncertain"].includes(w.status)).length > 1) throw new Error("Parallel mutating stages in persisted state");
 for (const w of s.works) if (!s.actions.some(a => a.id === w.actionId) || !["reserved", "active", "interrupted", "uncertain", "terminal"].includes(w.status)) throw new Error("Unowned persisted invocation");
 for (const a of s.artifacts) if (!/^[a-f0-9]{64}$/.test(a.sha256 ?? "") || a.provenance?.artifactId !== a.id || a.provenance?.taskId !== s.taskId || !s.works.some(w => w.id === a.producer)) throw new Error("Invalid artifact provenance");
 for (const r of s.official) if (!r.attemptId || (r.score !== undefined && (!Number.isFinite(r.score) || r.score < 0 || r.score > 1))) throw new Error("Invalid official feedback");
 if (!Number.isSafeInteger(s.cursor) || s.acknowledgedCursor > s.cursor || s.acknowledgedCursor < 0 || s.inbox.some(n => n.cursor > s.cursor)) throw new Error("Invalid notification cursor");
 if (!Number.isSafeInteger(s.remoteTriesUsed) || s.remoteTriesUsed < 0) throw new Error("Invalid remote attempt accounting");
 if (!Number.isSafeInteger(s.reservedUnknown) || s.reservedUnknown < 0 || s.reservedUnknown > 3) throw new Error("Invalid unknown submission reservations");
 for (const declared of [s.taskConfiguration, ...s.works.map(w => w.taskConfiguration && { configuration: w.taskConfiguration, sha256: taskConfigurationHash(w.taskConfiguration) })]) {
  if (declared && taskConfigurationHash(parseTaskConfiguration(declared.configuration)) !== declared.sha256) throw new Error("Invalid persisted task configuration");
 }
 if (s.taskConfiguration && !s.actions.some(a => a.id === s.taskConfiguration!.actionId && a.kind === "task_configure")) throw new Error("Unowned persisted task configuration");
}
export class StateStore {
 readonly path: string;
 private release: () => void;
 private value: RunState;
 private poisoned = false;
 constructor(readonly directory: string, initial?: RunState) {
  this.release = claimWorkspace(directory); this.path = join(directory, "state.json");
  try {
   if (existsSync(this.path)) {
    if (statSync(this.path).size > 32 * 1024 * 1024) throw new Error("Coordinator state exceeds disk bound");
    const envelope = JSON.parse(readFileSync(this.path, "utf8"));
    if (envelope.sha256 !== hash(envelope.state)) throw new Error("Coordinator checksum mismatch; restore durable state before effects");
    validate(envelope.state); this.value = envelope.state;
   } else { if (!initial) throw new Error("Missing run state"); validate(initial); this.value = structuredClone(initial); this.persist(this.value); }
  } catch (error) { this.release(); throw error; }
 }
 get state(): RunState { return structuredClone(this.value); }
 private persist(state: RunState) { atomicJson(this.path, { sha256: hash(state), state }); }
 transaction(kind: string, payload: Record<string, unknown>, update: (s: RunState) => void): RunState {
  if (this.poisoned) throw new Error("Coordinator durability failed; refusing further effects");
  const next = structuredClone(this.value); update(next);
  // Accounting reservations do not invalidate the decision revision carried by
  // the very tool call whose execution they guard. Their journal entries remain
  // durable and ordered; workspace/action/evidence changes advance the revision.
  if (kind !== "budget_reserved") next.revision++;
  next.journal.push({ revision: next.revision, at: Date.now(), kind, payload }); validate(next);
  try { this.persist(next); } catch (error) { this.poisoned = true; throw error; }
  this.value = next; return this.state;
 }
 close() { this.release(); }
}
export function initialState(options: { taskId: string; taskFingerprint: string; config: ResolvedPipelineConfig; promptTemplates: Record<string, string>; promptFingerprint: string; authorized: boolean; maxSubmissions?: number; targetScore?: number; limits?: Partial<Limits>; runId?: string }): RunState {
 const runId = options.runId ?? randomUUID(), controlInvocationId = randomUUID(), startedAt = Date.now();
 const limits = { ...HARNESS_CONFIG.orchestrator, ...options.limits };
 const state: RunState = { schemaVersion: 1, runId, controlInvocationId, taskId: options.taskId, taskFingerprint: options.taskFingerprint, config: structuredClone(options.config), promptTemplates: options.promptTemplates, promptFingerprint: options.promptFingerprint,
 policy: { version: 1, authorized: options.authorized, maxSubmissions: options.maxSubmissions ?? 3, pipelineRunId: runId, controllerInvocationId: controlInvocationId },
 goal: { objective: "maximize_official_score", targetScore: options.targetScore ?? 1 }, startedAt, deadline: startedAt + limits.maxWallMs, limits,
 counters: { sessions: 0, modelRequests: 0, toolCalls: 0, stages: 0, trials: 0, retries: 0 }, revision: 0, status: "running", works: [], actions: [], artifacts: [], official: [], remoteTriesUsed: 0, reservedUnknown: 0, cursor: 0, acknowledgedCursor: 0, inbox: [], journal: [] };
 validate(state); return state;
}
