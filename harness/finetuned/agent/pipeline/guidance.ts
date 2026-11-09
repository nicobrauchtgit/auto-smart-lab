/** Run data: provenance is checked against an explicit caller-owned evidence catalog. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { StageArtifact, StageName } from "./types.js";
import type { PromptSnapshot } from "../prompts/loader.js";
export interface EvidenceReference {
 artifactId: string; taskId: string; pipelineRunId: string; invocationId: string;
 sha256: string; datasetSha256?: string; candidateId?: string;
}
export interface StageGuidance {
 id: string; version: number; stage: StageName; taskId: string; content: string; objective?: string;
 author?: { name?: string; logicalSessionId?: string; physicalSessionId?: string };
 evidence: EvidenceReference[]; contentSha256: string;
}
export interface StageFeedback extends Omit<StageGuidance, "version" | "objective"> {}
export const guidanceHash = (value: Omit<StageGuidance, "contentSha256"> | Omit<StageFeedback, "contentSha256">) =>
 createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if (value && typeof value === "object") return `{${Object.keys(value).filter(key => (value as any)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(",")}}`;
 return JSON.stringify(value);
}
function object(value: unknown, keys: string[]) {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Guidance fields must be objects");
 if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unknown guidance fields/variables");
}
function text(value: unknown, limit = 256) {
 if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit) throw new Error("Malformed or oversized guidance field");
}
export function validateGuidance<T extends StageGuidance | StageFeedback>(raw: T, stage: StageName, taskId: string, catalog: StageArtifact[], feedback = false): T {
 if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 24576) throw new Error("Oversized guidance/feedback note");
 object(raw, ["id", "version", "stage", "taskId", "content", "objective", "author", "evidence", "contentSha256"].filter(k => !feedback || !["version", "objective"].includes(k)));
 if (!["research", "solve", "evaluate"].includes(stage)) throw new Error("Guidance/feedback unsupported for deterministic stage");
 if (raw.stage !== stage || raw.taskId !== taskId) throw new Error("Wrong guidance stage/task binding");
 text(raw.id); text(raw.taskId); text(raw.content, 8192);
 if (!feedback && (!Number.isSafeInteger((raw as StageGuidance).version) || (raw as StageGuidance).version < 1)) throw new Error("Invalid guidance version");
 if ((raw as StageGuidance).objective !== undefined) text((raw as StageGuidance).objective, 2048);
 if (raw.author !== undefined) { object(raw.author, ["name", "logicalSessionId", "physicalSessionId"]); for (const value of Object.values(raw.author)) text(value); }
 if (!Array.isArray(raw.evidence) || raw.evidence.length > 16) throw new Error("Invalid guidance evidence references");
 for (const ref of raw.evidence) {
  object(ref, ["artifactId", "taskId", "pipelineRunId", "invocationId", "sha256", "datasetSha256", "candidateId"]);
  for (const key of ["artifactId", "taskId", "pipelineRunId", "invocationId", "sha256"] as const) text(ref[key]);
  for (const key of ["datasetSha256", "candidateId"] as const) if (ref[key] !== undefined) text(ref[key]);
  if (ref.taskId !== taskId || !/^[a-f0-9]{64}$/.test(ref.sha256) || (ref.datasetSha256 !== undefined && !/^[a-f0-9]{64}$/.test(ref.datasetSha256))) throw new Error("Invalid evidence task/hash");
  const matches = catalog.filter(a => a.provenance?.artifactId === ref.artifactId);
  if (matches.length !== 1) throw new Error("Unknown or ambiguous evidence reference");
  const source = matches[0];
  if (!source?.provenance || canonical(source.provenance) !== canonical(ref) || source.sha256 !== ref.sha256) throw new Error("Unknown or mismatched evidence provenance");
  if (statSync(source.path).size > 64 * 1024 * 1024) throw new Error("Evidence exceeds bounded hash validation size");
  if (createHash("sha256").update(readFileSync(source.path)).digest("hex") !== ref.sha256) throw new Error("Stale evidence hash");
 }
 const { contentSha256, ...body } = raw;
 if (contentSha256 !== guidanceHash(body as any)) throw new Error("Stale guidance content hash");
 const copy = JSON.parse(JSON.stringify(raw));
 function freeze(value: any): any { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
 return freeze(copy);
}
export function guidanceBlock(prompts: PromptSnapshot, guidance?: StageGuidance) {
 return guidance ? prompts.render("shared.stage-guidance", { note: JSON.stringify(guidance) }) : undefined;
}
