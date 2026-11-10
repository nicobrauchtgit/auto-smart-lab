import type { StageArtifact, StageReporter } from "../pipeline/types.js";
export interface SubmissionPolicy { version: 1; authorized: boolean; maxSubmissions: number; pipelineRunId: string; controllerInvocationId: string }
export type SubmissionState = "disabled" | "unknown" | "pending" | "rejected" | "scored";
export interface OfficialAttempt { id: string; comment: string; state: Exclude<SubmissionState, "disabled" | "unknown">; score: number | null }
export interface OfficialStatus { taskUrl: string; triesUsed: number; triesRemaining: number; uploadAvailable: boolean; attempts: OfficialAttempt[] }
export interface TransportConfig { taskUrl: string; username: string; password: string; loginUrl?: string; timeoutMs?: number; ca?: string; cookie?: string }
export interface SubmissionResult { version: 1; state: SubmissionState; officialScore: number | null; triesUsed: number | null; triesRemaining: number | null; reservedUnknown: number; effectiveTriesUsed: number | null; newAttempt: boolean; attemptId: string | null; bundleId: string | null; artifacts: StageArtifact[] }
export interface SubmitRefitOptions { taskId: string; refitArtifact: StageArtifact; policy: SubmissionPolicy; transport: TransportConfig; accountingRoot: string; projectRoot: string; pythonExecutable: string; taskPromptPath: string; environmentFingerprint: string; env?: Record<string,string>; report?: StageReporter; /** Declared prediction domain; the frozen refit must agree. */ predictions?: "binary" | "cluster_id"; signal?: AbortSignal; pollTimeoutMs?: number; pollIntervalMs?: number }
export function validatePolicy(raw: unknown): SubmissionPolicy {
 const p = raw as SubmissionPolicy;
 if (!p || p.version !== 1 || typeof p.authorized !== "boolean" || !Number.isInteger(p.maxSubmissions) || p.maxSubmissions < 0 || p.maxSubmissions > 3 || !p.pipelineRunId?.trim() || !p.controllerInvocationId?.trim()) throw new Error("Missing or invalid controller submission policy");
 return Object.freeze({ version: 1, authorized: p.authorized, maxSubmissions: p.maxSubmissions, pipelineRunId: p.pipelineRunId, controllerInvocationId: p.controllerInvocationId });
}
export interface ReconcileSubmissionOptions { taskId:string; policy:SubmissionPolicy; transport:TransportConfig; accountingRoot:string; report?:StageReporter; signal?:AbortSignal }
export type ReadSubmissionAccountingOptions = Omit<ReconcileSubmissionOptions,"policy">;
export interface SubmissionAccounting { officialStatus:OfficialStatus; reservedUnknown:number; effectiveTriesUsed:number; unresolved:boolean }
