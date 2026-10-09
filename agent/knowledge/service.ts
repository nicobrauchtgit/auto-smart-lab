import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { collectTrainingTrial } from "../training/results.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { SuppliedInput } from "../pipeline/types.js";
import { digest, KnowledgeStore, safePath, validateOrigin, type EvidenceReceipt, type KnowledgeDraft, type KnowledgeOrigin, type KnowledgeNote } from "./store.js";
import { compareExperiments, experimentDirectory, experimentHistory, type ExperimentReference } from "./experiments.js";

export interface KnowledgeOptions {
 root: string; origin: KnowledgeOrigin;
 /** Controller-selected roots only; agents supply experiment IDs, never filesystem paths. */
 trainingRoots?: readonly string[];
 /** Controller-selected solutions repository for bounded read-only source diffs. */
 solutionsRoot?: string;
 record?: (type: string, payload: Record<string, unknown>) => void;
 reportInput?: (input: SuppliedInput) => void;
}
export const KNOWLEDGE_SKILLS = ["knowledge.task", "knowledge.refresh"] as const;
export function selectedKnowledge(prompts: PromptSnapshot) { return KNOWLEDGE_SKILLS.map(id => prompts.render(id, {})); }
export function knowledgeInput(options: KnowledgeOptions): SuppliedInput {
 return { kind: "task_knowledge", version: 1, delivery: "tool", status: "available", artifact: resolve(options.root),
  task_id: options.origin.taskId, dataset_sha256: options.origin.datasetSha256, reusable_lessons: true, authoritative_for_current_run: false,
  harness_roots: (options.trainingRoots ?? []).map((root, rootIndex) => ({ rootIndex, artifact: resolve(root) })) };
}

function within(root: string, path: string) { const delta = relative(safePath(root), safePath(path)); return delta === "" || (!delta.startsWith("..") && !delta.startsWith("/")); }
function boundedMetadata(value: unknown) {
 const bytes = JSON.stringify(value ?? null);
 return Buffer.byteLength(bytes) <= 2048 ? value : { content_sha256: digest(bytes), bytes: Buffer.byteLength(bytes), detail: "retained in hashed evidence artifact" };
}
async function harnessEvidence(root: string, id: string, origin: KnowledgeOrigin): Promise<EvidenceReceipt> {
 if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid harness experiment ID");
 safePath(root);
 const entries = readdirSync(root, { withFileTypes: true });
 if (entries.length > 100) throw new Error("Harness evidence root exceeds retrieval bound");
 for (const entry of entries) if (entry.isSymbolicLink()) throw new Error("Symlink in evidence root");
 const directory = safePath(join(root, id));
 const files = readdirSync(directory, { withFileTypes: true });
 if (files.length > 100) throw new Error("Harness trial file count exceeds retrieval bound");
 let bytes = 0;
 for (const file of files) {
  if (file.isSymbolicLink()) throw new Error("Symlink in harness evidence");
  if (file.isFile()) {
   const size = statSync(join(directory, file.name)).size;
   if (size > 128 * 1024 * 1024) throw new Error("Harness evidence file exceeds retrieval bound");
   bytes += size;
  }
 }
 if (bytes > 256 * 1024 * 1024) throw new Error("Harness trial exceeds retrieval byte bound");
 const trial = await collectTrainingTrial(directory);
 if (!trial?.valid || trial.result?.status !== "completed" || !trial.result.metrics || !trial.invocation || !trial.request) throw new Error("Existing completed validated harness evidence required");
 // Read only development harness outputs. Refit directories never have this receipt shape.
 const seed = JSON.parse(readFileSync(join(trial.directory, "seed-plan.json"), "utf8"));
 if (seed.taskId !== origin.taskId || seed.datasetSha256 !== origin.datasetSha256) throw new Error("Harness evidence task/dataset mismatch");
 const invocation = trial.invocation;
 const measurement = JSON.parse(readFileSync(join(trial.directory, "invocation.json"), "utf8")).measurement as { kind?: string; sampleManifestPath?: string } | undefined;
 if (!measurement?.sampleManifestPath) throw new Error("Retired decoded-text evidence: raw sample metadata is required");
 // The development data the solve fingerprint covers: archive bytes plus the raw manifest.
 const data = [invocation.inputs.zipPath, measurement.sampleManifestPath];
 if (!data.every(path => typeof path === "string" && existsSync(path))) throw new Error("Harness development data unavailable");
 if (digest(Buffer.concat(data.map(path => readFileSync(safePath(path as string))))) !== origin.datasetSha256) throw new Error("Harness development dataset changed");
 const checkpoint = join(trial.directory, trial.request.search ? "search-checkpoint.json" : "single-checkpoint.json");
 safePath(checkpoint);
 if (!existsSync(checkpoint) || statSync(checkpoint).size > 128 * 1024 * 1024) throw new Error("Harness checkpoint unavailable or oversized");
 const paths = [...trial.artifacts.map(a => a.path), checkpoint, join(trial.directory, "invocation.json"), join(trial.directory, "request.json")];
 const recoveryPath = join(trial.directory, "recovery.json");
 if (existsSync(recoveryPath)) paths.push(recoveryPath);
 const artifacts = [...new Set(paths)].map(path => {
  if (!within(root, path) || statSync(path).size > 128 * 1024 * 1024) throw new Error("Unsafe or oversized evidence artifact");
  return { path: resolve(path), sha256: digest(readFileSync(path)) };
 });
 if (trial.artifacts.some(artifact => artifacts.find(a => a.path === resolve(artifact.path))?.sha256 !== artifact.sha256)) throw new Error("Harness evidence changed during collection");
 const verification = spawnSync(join(resolve(PROJECT_ROOT, process.env.VENV_DIR ?? ".venv"), "bin/python"),
  ["-I", join(PROJECT_ROOT, "agent/knowledge/verify_evidence.py"), trial.directory],
  { env: sanitizeTrainingEnvironment(process.env), encoding: "utf8", timeout: 10000, maxBuffer: 100000 });
 if (verification.error || verification.status !== 0) throw new Error("Harness prediction/checkpoint measurement verification failed");
 const verified = JSON.parse(verification.stdout);
 const metric = measurement?.kind === "clustering" ? "adjustedRandIndex" : measurement?.kind === "anomaly_detection" ? "selectionScore" : "balancedAccuracy";
 if (typeof trial.result.metrics[metric] !== "number" || verified.verified !== true || verified.metrics[metric] !== trial.result.metrics[metric]) throw new Error("Harness measurement verification failed");
 const recovery = existsSync(recoveryPath) ? JSON.parse(readFileSync(safePath(recoveryPath), "utf8")) : undefined;
 if (recovery) {
  if (recovery.taskId !== origin.taskId || recovery.datasetSha256 !== origin.datasetSha256 || recovery.invocationHash !== digest(readFileSync(join(trial.directory, "invocation.json")))) throw new Error("Harness origin receipt mismatch");
 }
 for (const artifact of artifacts) if (digest(readFileSync(safePath(artifact.path))) !== artifact.sha256) throw new Error("Harness evidence changed during verification");
 if (digest(Buffer.concat(data.map(path => readFileSync(safePath(path as string))))) !== origin.datasetSha256) throw new Error("Harness dataset changed during verification");
 return { producer: "training-harness", experimentId: id, taskId: origin.taskId, datasetSha256: origin.datasetSha256,
  ...(recovery?.originPipelineRunId ? { pipelineRunId: recovery.originPipelineRunId } : {}),
  ...(recovery?.originStageInvocationId ? { stageInvocationId: recovery.originStageInvocationId } : {}),
  scope: trial.result.scope!, source: invocation.source ?? null,
  parameters: { factory: trial.request.pipeline.parameters ?? null, estimator: trial.request.pipeline.estimatorParams ?? {}, ...(verified.parameters ? { searchWinner: verified.parameters } : {}) },
  cv: { design: trial.request.cv, completedFolds: trial.result.completedFolds, search: !!trial.request.search,
   ...(measurement?.kind !== "classification" ? { measurement: trial.invocation.measurement } : {}) },
  metrics: { [metric]: trial.result.metrics[metric] as number }, artifacts };
}

export class TaskKnowledge {
 readonly store: KnowledgeStore;
 private origin: KnowledgeOrigin;
 readonly options: KnowledgeOptions;
 constructor(options: KnowledgeOptions) {
  validateOrigin(options.origin); this.origin = { ...options.origin };
  this.options = { ...options, origin: Object.freeze({ ...options.origin }), trainingRoots: Object.freeze([...(options.trainingRoots ?? [])]) };
  this.store = new KnowledgeStore(options.root);
 }
 bindAgent(agentRunId?: string) { this.origin = { ...this.origin, agentRunId }; }
 private record(type: string, payload: Record<string, unknown>) { this.options.record?.(type, { ...this.origin, ...payload }); }
 private same(note: KnowledgeNote) { return note.origin.taskId === this.origin.taskId && note.origin.datasetSha256 === this.origin.datasetSha256; }
 search(query: string, limit = 8) {
  if (typeof query !== "string" || query.length > 200 || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error("Invalid bounded knowledge search");
  const terms = query.toLowerCase().split(/\s+/).slice(0, 10);
  const matches = this.store.notes().flatMap(note => {
   const latest = note.revisions.at(-1)!;
   if (latest.lifecycle && latest.lifecycle !== "active") return [];
   const same = this.same(note);
   if (!same && !latest.reusable) return [];
   // Cross-task matching never consults task body, title, summary or tags.
   const haystack = (same ? [latest.title, latest.summary, ...latest.tags] : Object.values(latest.reusable!)).join(" ").toLowerCase();
   const relevance = terms.filter(term => haystack.includes(term)).length;
   if (!relevance) return [];
   return [{ id: note.id, revision: latest.revision, summary: same ? latest.summary : latest.reusable!.lesson.slice(0, 400),
    kind: same ? "task" : "reusable", status: same ? latest.status : "origin_lesson_requires_validation",
    evidenceStatus: "summary_requires_scoped_read", authoritativeForCurrentRun: false,
    origin: { taskId: note.origin.taskId, datasetSha256: note.origin.datasetSha256 }, relevance }];
  }).sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id)).slice(0, limit);
  this.record("knowledge_search", { query, limit, retrieved: matches.map(m => ({ id: m.id, revision: m.revision, kind: m.kind })) });
  this.options.reportInput?.({ ...knowledgeInput(this.options), retrieved_ids: matches.map(m => m.id), query });
  return matches;
 }
 async read(id: string, revision?: number) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid knowledge ID");
  const note = this.store.notes().find(note => note.id === id);
  if (!note) throw new Error("Knowledge note unavailable");
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error("Invalid knowledge revision");
  const latest = revision === undefined ? note.revisions.at(-1)! : note.revisions.find(value => value.revision === revision);
  if (!latest) throw new Error("Knowledge revision unavailable");
  let value: unknown;
  if (!this.same(note)) {
   if (!latest.reusable) throw new Error("Knowledge dataset mismatch");
   value = { id, revision: latest.revision, lifecycle: latest.lifecycle ?? "active", origin: { taskId: note.origin.taskId, datasetSha256: note.origin.datasetSha256 },
    reusable: latest.reusable, evidenceStatus: "origin_lesson_requires_validation", authoritativeForCurrentRun: false };
  } else {
   let evidenceStatus = "agent_assertion";
   if (latest.evidence) {
    evidenceStatus = "stale_or_unavailable";
    try {
     const receipt = latest.evidence;
     const root = dirname(dirname(receipt.artifacts.find(a => a.path.endsWith("/invocation.json"))!.path));
     if (!(this.options.trainingRoots ?? []).some(allowed => within(allowed, root))) throw new Error("Evidence root no longer supplied");
     const current = await harnessEvidence(root, receipt.experimentId, note.origin);
     if (JSON.stringify(current) === JSON.stringify(receipt)) evidenceStatus = "verified_historical_harness_measurement";
    } catch { /* Historical prose is retained but never upgrades missing/corrupt evidence. */ }
   }
   value = { id, origin: note.origin, ...latest,
    ...(latest.evidence ? { evidence: { ...latest.evidence, source: boundedMetadata(latest.evidence.source), parameters: boundedMetadata(latest.evidence.parameters), cv: boundedMetadata(latest.evidence.cv), artifacts: boundedMetadata(latest.evidence.artifacts) } } : {}),
    evidenceStatus, authoritativeForCurrentRun: false,
    historicalRevision: latest.revision !== note.revisions.at(-1)!.revision,
    history: note.revisions.filter(r => r.revision < latest.revision).map(r => ({ revision: r.revision, at: r.at, status: r.status, lifecycle: r.lifecycle ?? "active", sha256: r.sha256 })) };
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw new Error("Knowledge read exceeds 32 KiB response bound; inspect the retained scoped artifacts");
  const hash = digest(JSON.stringify(value));
  this.record("knowledge_read", { id, revision: latest.revision, content_sha256: hash, input: value });
  this.options.reportInput?.({ ...knowledgeInput(this.options), note_id: id, revision: latest.revision, content_sha256: hash });
  return value;
 }
 history(offset = 0, limit = 8) {
  const value = experimentHistory(this.options.trainingRoots ?? [], this.origin, offset, limit);
  this.record("experiment_history", { offset, limit, content_sha256: digest(JSON.stringify(value)), input: value });
  this.options.reportInput?.({ ...knowledgeInput(this.options), content_sha256: digest(JSON.stringify(value)), experiment_references: value.experiments.map(row => row.reference) });
  return value;
 }
 compare(left: ExperimentReference, right: ExperimentReference) {
  const value = compareExperiments(this.options.trainingRoots ?? [], this.origin, left, right, this.options.solutionsRoot ?? join(PROJECT_ROOT, "solutions"));
  this.record("experiment_compare", { left, right, content_sha256: digest(JSON.stringify(value)), input: value });
  this.options.reportInput?.({ ...knowledgeInput(this.options), content_sha256: digest(JSON.stringify(value)), experiment_references: [left, right] });
  return value;
 }
 async compareNotes(left: string, right: string, leftRevision?: number, rightRevision?: number) {
  const before = await this.read(left, leftRevision), after = await this.read(right, rightRevision);
  const value = { left: before, right: after,
   limitation: "Compare observations, outcomes and caveats, then capture a reusable lesson. Unverified signals and agent assertions do not establish a measured or causal improvement. No champion is required." };
  this.record("knowledge_compare", { left, right, leftRevision, rightRevision, content_sha256: digest(JSON.stringify(value)) });
  return value;
 }
 async capture(draft: KnowledgeDraft, experiment?: ExperimentReference, update?: { id: string; expectedRevision: number }) {
  let evidence: EvidenceReceipt | undefined;
  if (experiment) {
   const roots = this.options.trainingRoots ?? [];
   if (!Number.isInteger(experiment.rootIndex) || experiment.rootIndex < 0 || !roots[experiment.rootIndex]) throw new Error("Harness root unavailable");
   const directory = experimentDirectory(roots, experiment);
   evidence = await harnessEvidence(dirname(directory), experiment.id, this.origin);
  }
  const captured = this.store.capture(this.origin, draft, evidence, update);
  this.record("knowledge_capture", { id: captured.note.id, revision: captured.note.revisions.length, deduplicated: captured.deduplicated,
   artifact: captured.artifact, artifact_sha256: captured.artifactSha256, evidence });
  return { id: captured.note.id, revision: captured.note.revisions.length, deduplicated: captured.deduplicated };
 }
}
export function createKnowledgeTools(service: TaskKnowledge, prompts: PromptSnapshot) {
 const description = prompts.render("knowledge.tool", {}).text;
 const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
 const reference = () => Type.Object({ rootIndex: Type.Integer({ minimum: 0 }), run: Type.Optional(Type.String()), id: Type.String() });
 return [
  ...(service.options.trainingRoots?.length ? [
  defineTool({ name: "experiment_history", label: "Read previous experiments", description: prompts.render("knowledge.history-tool", {}).text,
   parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }),
   async execute(_, args) { return result(service.history(args.offset, args.limit)); } }),
  defineTool({ name: "experiment_compare", label: "Compare previous experiments", description: prompts.render("knowledge.compare-tool", {}).text,
   parameters: Type.Object({ left: reference(), right: reference() }),
   async execute(_, args) { return result(service.compare(args.left, args.right)); } }),
  ] : []),
  defineTool({ name: "knowledge_compare", label: "Compare observations and lessons", description: prompts.render("knowledge.compare-notes-tool", {}).text,
   parameters: Type.Object({ left: Type.String(), right: Type.String(), leftRevision: Type.Optional(Type.Integer({ minimum: 1 })), rightRevision: Type.Optional(Type.Integer({ minimum: 1 })) }),
   async execute(_, args) { return result(await service.compareNotes(args.left, args.right, args.leftRevision, args.rightRevision)); } }),
  defineTool({ name: "knowledge_search", label: "Search task knowledge", description, parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer()) }),
   async execute(_, args) { return result(service.search(args.query, args.limit)); } }),
  defineTool({ name: "knowledge_read", label: "Read task knowledge", description, parameters: Type.Object({ id: Type.String(), revision: Type.Optional(Type.Integer({ minimum: 1 })) }),
   async execute(_, args) { return result(await service.read(args.id, args.revision)); } }),
  defineTool({ name: "knowledge_capture", label: "Capture or update task knowledge", description,
   parameters: Type.Object({ draft: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }), summary: Type.String({ minLength: 1, maxLength: 400 }),
    body: Type.String({ minLength: 1, maxLength: 6000 }), tags: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 12 }),
    status: Type.Union([Type.Literal("hypothesis"), Type.Literal("observation"), Type.Literal("empirical")]),
    applicability: Type.String({ minLength: 1, maxLength: 1000 }), caveats: Type.String({ minLength: 1, maxLength: 1000 }),
    lifecycle: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("stale"), Type.Literal("superseded")])),
    reusable: Type.Optional(Type.Object({ lesson: Type.String({ minLength: 1, maxLength: 1200 }), applicability: Type.String({ minLength: 1, maxLength: 1000 }), caveats: Type.String({ minLength: 1, maxLength: 1000 }) })),
   }), experiment: Type.Optional(reference()), update: Type.Optional(Type.Object({ id: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }) })) }),
   async execute(_, args) { return result(await service.capture(args.draft, args.experiment, args.update)); } }),
 ];
}
