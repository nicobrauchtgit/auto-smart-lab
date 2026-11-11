export type TeamRole = "lead" | "data" | "ideas" | "validation";
export type ScoutRole = Exclude<TeamRole, "lead">;
export type FindingKind = "fact" | "idea" | "result" | "defect" | "decision";
export type FindingRef = { experiment: string } | { file: string; line: number; commit?: string } |
 { check: string; experiment?: string; sha256: string } | { url: string } | { profile: string } | { entry: string };
export type FindingEntry = {
 id: string; cursor: number; kind: FindingKind;
 author: { role: TeamRole; invocationId: string; runId: string };
 title: string; text: string; refs: FindingRef[]; datasetSha256: string;
};
export type FindingResolution = { cursor: number; id: string; status: "superseded"; supersededBy?: string };
export type FindingsStatus = { cursor: number; counts: Partial<Record<FindingKind, number>>;
 newEntries: { id: string; title: string }[]; staleRefs: string[] };
export interface FindingsReader { status(taskId: string, cursor?: number): Promise<FindingsStatus> }
