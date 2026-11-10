import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StageArtifact, StageName, StageReporter } from "./types.js";
import { validateGuidance, guidanceHash, type StageFeedback } from "./guidance.js";
import type { PromptSnapshot, PromptReference } from "../prompts/loader.js";
export interface FeedbackReceipt {
 id: string; status: "queued" | "delivered" | "refused"; reason?: string; nextInvocation?: boolean;
}
export interface FeedbackSession { deliverFeedback(id: string, text: string, delivered: () => void, promptReference?: PromptReference): Promise<boolean>; }
/** In-memory ownership with a durable append-only receipt journal; not host recovery. */
export class InvocationFeedback {
 private session?: FeedbackSession;
 private finished = false;
 private receipts = new Map<string, { hash: string; note: StageFeedback; receipt: FeedbackReceipt }>();
 private draining?: Promise<void>;
 private phase: "preparing" | "active" | "between-attempts" | "finishing" | "terminal" = "preparing";
 get state() { return this.phase; }
 constructor(private readonly options: { stage: StageName; taskId: string; catalog: StageArtifact[];
  prompts: PromptSnapshot; report: StageReporter; journalPath: string }) {}
 private record(receipt: FeedbackReceipt, note?: StageFeedback) {
  mkdirSync(dirname(this.options.journalPath), { recursive: true });
  appendFileSync(this.options.journalPath, JSON.stringify({ ...receipt, ...(note ? { note } : {}), at: new Date().toISOString(),
   ...this.options.report.agentIdentity(0) }) + "\n", { flush: true });
  this.options.report.event("stage_feedback_receipt", { ...receipt, journal: this.options.journalPath });
 }
 async send(raw: StageFeedback): Promise<FeedbackReceipt> {
  if (!raw || typeof raw.id !== "string" || !raw.id.trim() || Buffer.byteLength(raw.id) > 256 || Buffer.byteLength(JSON.stringify(raw)) > 24576) throw new Error("Malformed or oversized feedback");
  if (Object.keys(raw).some(key => !["id", "stage", "taskId", "content", "author", "evidence", "contentSha256"].includes(key)) ||
   (raw.author && Object.keys(raw.author).some(key => !["name", "logicalSessionId", "physicalSessionId"].includes(key))) ||
   (Array.isArray(raw.evidence) && raw.evidence.some(ref => ref && Object.keys(ref).some(key => !["artifactId", "taskId", "pipelineRunId", "invocationId", "sha256", "datasetSha256", "candidateId"].includes(key))))) throw new Error("Unknown feedback fields/variables");
  const prior = this.receipts.get(raw.id);
  if (prior) {
   if (prior.hash !== raw.contentSha256) throw new Error("Feedback ID reused with different content");
   // Still validate the payload, so a claimed hash cannot hide changed content.
   const { contentSha256: _, ...body } = raw;
   if (guidanceHash(body) !== prior.hash) throw new Error("Stale feedback content hash");
   return { ...prior.receipt };
  }
  if (this.receipts.size >= 64) throw new Error("Invocation feedback budget reached (64)");
  const supported = ["research", "solve", "evaluate"].includes(this.options.stage);
  if (this.finished || !supported) {
   const receipt: FeedbackReceipt = { id: raw?.id, status: "refused", reason: !supported ? "Feedback unsupported" : "Stage finished; use next invocation", nextInvocation: supported && this.finished };
   this.record(receipt);
   this.receipts.set(raw.id, { hash: raw.contentSha256, note: structuredClone(raw), receipt });
   return { ...receipt };
  }
  const note = validateGuidance(raw, this.options.stage, this.options.taskId, this.options.catalog, true);
  const receipt: FeedbackReceipt = { id: note.id, status: "queued" };
  this.record(receipt, note);
  this.receipts.set(note.id, { hash: note.contentSha256, note, receipt });
  this.options.report.input({ kind: "stage_feedback", version: 1, delivery: "tool", status: "available",
   content_sha256: note.contentSha256, note, artifact: this.options.journalPath });
  await this.drain(); return { ...receipt };
 }
 async bind(session: FeedbackSession): Promise<void> { if (this.finished) return; this.phase = "active"; this.session = session; await this.drain(); }
 unbind(session: FeedbackSession): void { if (this.session === session) { this.session = undefined; if (!this.finished) this.phase = "between-attempts"; } }
 private drain(): Promise<void> {
  if (this.draining) return this.draining;
  this.draining = (async () => {
   for (const item of this.receipts.values()) {
    if (this.finished || !this.session) break;
    if (item.receipt.status !== "queued") continue;
    const message = this.options.prompts.render("shared.stage-feedback", { note: JSON.stringify(item.note) });
    await this.session.deliverFeedback(item.note.id, message.text, () => {
     if (!this.finished && item.receipt.status === "queued") { this.record({ ...item.receipt, status: "delivered" }); item.receipt.status = "delivered"; }
    }, message.reference);
   }
  })().finally(() => { this.draining = undefined; });
  return this.draining;
 }
 async finish(): Promise<void> {
  this.finished = true; this.phase = "finishing"; this.session = undefined;
  await this.draining;
  for (const item of this.receipts.values()) if (item.receipt.status === "queued") {
   item.receipt.status = "refused"; item.receipt.reason = "Stage finished before delivery; use next invocation";
   item.receipt.nextInvocation = true; this.record(item.receipt);
  }
  this.phase = "terminal";
 }
}
