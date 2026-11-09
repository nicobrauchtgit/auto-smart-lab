/** Durable bounded knowledge. JSON is authoritative; immutable Markdown revisions are readable mirrors. */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
export type KnowledgeStatus = "hypothesis" | "observation" | "empirical";
export interface KnowledgeOrigin { taskId: string; datasetSha256: string; pipelineRunId?: string; stageInvocationId?: string; agentRunId?: string; logicalAgentId?: string }
export interface EvidenceReceipt {
 producer: "training-harness"; experimentId: string; taskId: string; datasetSha256: string;
 pipelineRunId?: string; stageInvocationId?: string; scope: string; source: unknown; parameters: unknown; cv: unknown;
 metrics: { balancedAccuracy?: number; adjustedRandIndex?: number; selectionScore?: number }; artifacts: { path: string; sha256: string }[];
}
export interface KnowledgeDraft {
 title: string; summary: string; body: string; tags: string[]; status: KnowledgeStatus;
 applicability: string; caveats: string; lifecycle?: "active" | "stale" | "superseded";
 reusable?: { lesson: string; applicability: string; caveats: string };
}
export interface KnowledgeRevision extends KnowledgeDraft { revision: number; at: string; author: KnowledgeOrigin; evidence?: EvidenceReceipt; sha256: string }
export interface KnowledgeNote { id: string; origin: KnowledgeOrigin; revisions: KnowledgeRevision[] }
interface State { schemaVersion: 1; notes: KnowledgeNote[] }
function markdown(revision: KnowledgeRevision) {
 return `# ${revision.title}\n\n${revision.summary}\n\n${revision.body}\n\nApplicability: ${revision.applicability}\n\nCaveats: ${revision.caveats}\n\n\`\`\`json\n${JSON.stringify(revision, null, 2)}\n\`\`\`\n`;
}

function text(value: unknown, max: number): asserts value is string {
 if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max || /\u0000/.test(value)) throw new Error("Invalid or oversized knowledge text (UTF-8 byte limit)");
 // This blocks common accidental secret/label dumps, not arbitrary prose exfiltration.
 if (/-----BEGIN .*PRIVATE KEY|\bBearer\s+[\w.-]{12,}|\b(?:api[_-]?key|authorization)\s*[:=]\s*\S+|\b(?:sealed[_ -]labels|test[_ -]pseudo[_ -]targets|post[_ -]refit[_ -]score)\s*[:=]/i.test(value)) throw new Error("Restricted content in knowledge text");
}
export function validateOrigin(origin: KnowledgeOrigin) {
 text(origin.taskId, 200);
 if (!HASH.test(origin.datasetSha256)) throw new Error("Knowledge requires a dataset SHA256");
 for (const key of ["pipelineRunId", "stageInvocationId", "agentRunId", "logicalAgentId"] as const) if (origin[key] !== undefined) text(origin[key], 200);
}
export function validateDraft(draft: KnowledgeDraft) {
 if (!draft || typeof draft !== "object" || Object.keys(draft).some(k => !["title", "summary", "body", "tags", "status", "applicability", "caveats", "lifecycle", "reusable"].includes(k))) throw new Error("Unknown knowledge fields");
 text(draft.title, 160); text(draft.summary, 400); text(draft.body, 6000); text(draft.applicability, 1000); text(draft.caveats, 1000);
 if (!["hypothesis", "observation", "empirical"].includes(draft.status)) throw new Error("Invalid evidence status");
 if (draft.lifecycle !== undefined && !["active", "stale", "superseded"].includes(draft.lifecycle)) throw new Error("Invalid lifecycle");
 if (!Array.isArray(draft.tags) || draft.tags.length > 12) throw new Error("Invalid tags");
 draft.tags.forEach(tag => text(tag, 60));
 if (draft.reusable) {
  if (Object.keys(draft.reusable).some(k => !["lesson", "applicability", "caveats"].includes(k))) throw new Error("Unknown reusable fields");
  text(draft.reusable.lesson, 1200); text(draft.reusable.applicability, 1000); text(draft.reusable.caveats, 1000);
 }
 if (Buffer.byteLength(JSON.stringify(draft), "utf8") > 16 * 1024) throw new Error("Knowledge draft exceeds 16 KiB serialized bound; shorten or split the lesson");
}
function validateReceipt(receipt: EvidenceReceipt, origin: KnowledgeOrigin) {
 const metrics = Object.entries(receipt.metrics ?? {});
 const validMetric = metrics.length === 1 && metrics.every(([key, value]) =>
  ["balancedAccuracy", "adjustedRandIndex", "selectionScore"].includes(key) && typeof value === "number"
   && Number.isFinite(value) && value >= (key === "adjustedRandIndex" ? -1 : 0) && value <= 1);
 if (receipt.producer !== "training-harness" || receipt.taskId !== origin.taskId || receipt.datasetSha256 !== origin.datasetSha256
  || !["pilot", "promotion"].includes(receipt.scope) || !validMetric
  || !Array.isArray(receipt.artifacts) || !receipt.artifacts.length || receipt.artifacts.length > 30) throw new Error("Invalid harness receipt");
 for (const artifact of receipt.artifacts) if (typeof artifact.path !== "string" || !HASH.test(artifact.sha256)) throw new Error("Invalid evidence artifact");
}
/** Refuse symlink components, including a non-existent root's existing ancestors. */
export function safePath(path: string) {
 const absolute = resolve(path);
 let cursor = parse(absolute).root;
 for (const part of absolute.slice(cursor.length).split("/").filter(Boolean)) {
  cursor = join(cursor, part);
  try {
   if (lstatSync(cursor).isSymbolicLink()) throw new Error("Knowledge paths cannot traverse symlinks");
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
 }
 return absolute;
}
function atomic(path: string, bytes: string) {
 safePath(path);
 const temporary = `${path}.${randomUUID()}.tmp`;
 const fd = openSync(temporary, "wx", 0o600);
 try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
 renameSync(temporary, path);
 const directory = openSync(dirname(path), "r");
 try { fsyncSync(directory); } finally { closeSync(directory); }
}
export class KnowledgeStore {
 readonly root: string;
 constructor(root: string) { this.root = safePath(root); }
 preflight() {
  safePath(this.root);
  let ancestor = this.root;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!lstatSync(ancestor).isDirectory()) throw new Error("Knowledge ancestor is not a directory");
  accessSync(ancestor, constants.R_OK | constants.W_OK | constants.X_OK);
  if (existsSync(join(this.root, ".write-lock"))) throw new Error("Knowledge write lock exists; inspect interrupted writer before removing it");
  this.load();
 }
 private load(): State {
  const path = safePath(join(this.root, "index.json"));
  if (!existsSync(path)) return { schemaVersion: 1, notes: [] };
  if (!lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) throw new Error("Knowledge index exceeds bound");
  const state: State = JSON.parse(readFileSync(path, "utf8"));
  if (state.schemaVersion !== 1 || !Array.isArray(state.notes) || state.notes.length > 500) throw new Error("Invalid knowledge index");
  const ids = new Set<string>();
  for (const note of state.notes) {
   if (!ID.test(note.id) || ids.has(note.id) || !Array.isArray(note.revisions) || !note.revisions.length || note.revisions.length > 20) throw new Error("Invalid knowledge history");
   ids.add(note.id); validateOrigin(note.origin);
   for (const [index, revision] of note.revisions.entries()) {
    const { revision: version, at, author, evidence, sha256, ...draft } = revision;
    validateDraft(draft); validateOrigin(author);
    if (author.taskId !== note.origin.taskId || author.datasetSha256 !== note.origin.datasetSha256 || version !== index + 1 || !Number.isFinite(Date.parse(at))) throw new Error("Invalid knowledge ownership/revision");
    if (draft.status === "empirical" && !evidence) throw new Error("Empirical note lacks evidence");
    if (evidence) validateReceipt(evidence, note.origin);
    const { sha256: _, ...payload } = revision;
    if (digest(JSON.stringify(payload)) !== sha256) throw new Error("Corrupt knowledge revision");
    const mirror = safePath(join(this.root, `${note.id}-v${version}.md`));
    if (!existsSync(mirror) || !lstatSync(mirror).isFile() || lstatSync(mirror).size > 128 * 1024
     || readFileSync(mirror, "utf8") !== markdown(revision)) throw new Error("Corrupt or missing knowledge Markdown revision");
   }
  }
  return state;
 }
 notes() { return this.load().notes; }
 capture(origin: KnowledgeOrigin, draft: KnowledgeDraft, evidence?: EvidenceReceipt, update?: { id: string; expectedRevision: number }) {
  validateOrigin(origin); validateDraft(draft);
  if (draft.status === "empirical" && !evidence) throw new Error("Empirical notes require validated harness evidence");
  if (evidence) validateReceipt(evidence, origin);
  safePath(this.root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
  const lock = join(this.root, ".write-lock");
  try { mkdirSync(lock); } catch { throw new Error("Knowledge writer busy; retry after rereading"); }
  try {
   const state = this.load();
   const id = digest(JSON.stringify([origin.taskId, origin.datasetSha256, draft.title.trim().toLowerCase()])).slice(0, 32);
   let note = state.notes.find(note => note.id === (update?.id ?? id));
   if (update) {
    if (!note || note.origin.taskId !== origin.taskId || note.origin.datasetSha256 !== origin.datasetSha256) throw new Error("Cannot update another task or dataset");
    if (note.revisions.length !== update.expectedRevision) throw new Error("Knowledge revision conflict; reread before updating");
   } else if (note) {
    const prior = note.revisions.at(-1)!;
    if (JSON.stringify(draft) === JSON.stringify(Object.fromEntries(Object.entries(prior).filter(([k]) => !["revision", "at", "author", "evidence", "sha256"].includes(k)))) && JSON.stringify(evidence) === JSON.stringify(prior.evidence)) return { note, deduplicated: true };
    throw new Error("Related knowledge title exists; read and update its revision");
   }
   if (!note) { if (state.notes.length >= 500) throw new Error("Knowledge store full"); note = { id, origin: { ...origin }, revisions: [] }; state.notes.push(note); }
   if (note.revisions.length >= 20) throw new Error("Knowledge revision history full; retain history and create a distinctly named successor");
   const payload = { ...structuredClone(draft), revision: note.revisions.length + 1, at: new Date().toISOString(), author: { ...origin }, ...(evidence ? { evidence: structuredClone(evidence) } : {}) };
   const revision = { ...payload, sha256: digest(JSON.stringify(payload)) };
   note.revisions.push(revision);
   const serialized = JSON.stringify(state, null, 2) + "\n";
   if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error("Knowledge store byte bound exceeded");
   const markdownPath = join(this.root, `${note.id}-v${revision.revision}.md`);
   const markdownBytes = markdown(revision);
   if (Buffer.byteLength(markdownBytes) > 128 * 1024) throw new Error("Knowledge revision exceeds readable artifact bound");
   atomic(markdownPath, markdownBytes);
   atomic(join(this.root, "index.json"), serialized);
   return { note, deduplicated: false, artifact: markdownPath, artifactSha256: digest(readFileSync(markdownPath)) };
  } finally { rmSync(lock, { recursive: true }); }
 }
}
