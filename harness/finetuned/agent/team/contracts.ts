/**
 * Single source of the shared team contract types (expert-team.md section 5).
 * Implementations import these; the workspace/ entry points re-export them.
 */
import type { SolveWorkspace } from "../solve/workspace.js";
import type { PipelineRequest, CvRequest } from "../training/types.js";

export type TeamRole = "lead" | "data" | "ideas" | "validation";
export type ScoutRole = Exclude<TeamRole, "lead">;

/** Controller-only retained task data; legacy solve and the team share one sealing implementation. */
export interface TaskData extends SolveWorkspace {
 materializedHashes: Record<string, string>; taskId: string; profilePath: string; datasetSha256: string;
 developmentArchive: string; developmentManifest: string; testArchive: string; originalTrainingPath: string;
}
/** One shared-tree code-work round: committed edits as well as uncommitted leftovers. */
export interface TreeState { commit: string; uncommittedFiles: string[]; moved: { from: string; to: string }[]; changedPaths: string[] }
/** Static checks of the shared authored tree. `blocking` lists findings that make a trial invalid. */
export interface WorkspaceCheck { valid: boolean; errors: string[]; warnings: string[]; blocking: string[]; measurements: Record<string, number>; changedPaths: string[] }
/** Immutable source of one measured trial, reconstructed from its receipt. */
export interface TrialSnapshot { experimentId: string; commit: string; tree: string; sourceRoot: string }
/** Allowlisted controller facts; contains no row identities, targets or confirmation feedback. */
export interface TrialReviewContext {
 experimentId: string; commit: string; tree: string;
 pipeline: PipelineRequest; cv: CvRequest;
 coverage: { requestedFolds: number; completedFolds: number };
 execution: "inductive" | "batch";
}
/** One development label row, as read from a task's targets file. */
export interface TrainingLabelRow { id: string; label: 0 | 1 }

export type FindingKind = "fact" | "idea" | "result" | "defect" | "decision";
export type FindingRef = { experiment: string } | { file: string; line: number; commit?: string } |
 { check: string; experiment?: string; sha256: string } | { url: string } | { profile: string } | { entry: string };
export interface TrialMeasurement {
 experimentId: string; source: string; status: string; metric?: string; score?: number;
 foldScores: number[]; mean?: number; sd?: number; elapsedSeconds?: number; peakRssMb?: number;
 sourceCommit?: string; sourceTree?: string; scope?: string; promotionEligible?: boolean; requestedFolds?: number; completedFolds?: number;
}
export type FindingEntry = {
 /** Absent on legacy per-task entries. New shared records always use version 2. */
 schemaVersion?: 2; taskId?: string; producerModel?: string; requestId?: string;
 legacy?: {taskId: string; source: string; cursor: number; id: string; recordSha256?: string};
 measurement?: TrialMeasurement;
 id: string; cursor: number; kind: FindingKind;
 author: { role: TeamRole; invocationId: string; runId: string };
 title: string; text: string; refs: FindingRef[]; datasetSha256: string;
};
export type FindingResolution = { cursor: number; id: string; status: "superseded"; supersededBy?: string };
export type FindingsStatus = { cursor: number; counts: Partial<Record<FindingKind, number>>;
 newEntries: { id: string; title: string }[]; staleRefs: string[] };
export interface FindingsReader { status(taskId: string, cursor?: number): Promise<FindingsStatus> }

/** Harness execution evidence, independent of written findings. null means execution did not complete. */
export interface ValidationCheckResult { path: string; sha256?: string; exitCode: number | null; output: string }
