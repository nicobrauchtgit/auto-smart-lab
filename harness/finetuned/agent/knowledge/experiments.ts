/** Read-only history from controller-selected roots. Never trains or selects. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, safePath, type KnowledgeOrigin } from "./store.js";

export interface ExperimentReference { rootIndex: number; run?: string; id: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export function experimentDirectory(roots: readonly string[], ref: ExperimentReference): string {
 if (!Number.isInteger(ref.rootIndex) || ref.rootIndex < 0 || !roots[ref.rootIndex]) throw new Error("Harness root unavailable");
 if (!identifier.test(ref.id) || (ref.run !== undefined && !identifier.test(ref.run))) throw new Error("Invalid harness experiment reference");
 return safePath(join(roots[ref.rootIndex], ...(ref.run ? [ref.run] : []), ref.id));
}
function json(directory: string, name: string): Record<string, any> | undefined {
 const path = safePath(join(directory, name));
 if (!existsSync(path)) return undefined;
 if (statSync(path).size > 1024 * 1024) throw new Error("History metadata exceeds 1 MiB; inspect scoped artifacts");
 const value: unknown = JSON.parse(readFileSync(path, "utf8"));
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history metadata");
 return value as Record<string, any>;
}
function compact(value: unknown) {
 const bytes = JSON.stringify(value ?? null);
 return Buffer.byteLength(bytes) <= 2048 ? value : { sha256: digest(bytes), bytes: Buffer.byteLength(bytes), detail: "Inspect the scoped experiment artifact" };
}
function load(roots: readonly string[], origin: KnowledgeOrigin, ref: ExperimentReference) {
 const directory = experimentDirectory(roots, ref);
 const seed = json(directory, "seed-plan.json");
 if (seed?.taskId !== origin.taskId || seed.datasetSha256 !== origin.datasetSha256) throw new Error("Experiment task/dataset mismatch");
 const request = json(directory, "request.json");
 if (!request || seed.experimentId !== ref.id) throw new Error("Experiment identity unavailable");
 const invocation = json(directory, "invocation.json");
 if (invocation?.experimentId !== ref.id) throw new Error("Experiment invocation mismatch");
 const result = json(directory, "trial-result.json");
 if (result && result.experimentId !== ref.id) throw new Error("Experiment result mismatch");
 const recovery = json(directory, "recovery.json");
 const report = json(directory, "search-report.json");
 const source = invocation.source ?? recovery?.trial?.source;
 if (typeof request.hypothesis !== "string" || Buffer.byteLength(request.hypothesis) > 2000) throw new Error("Invalid history hypothesis");
 const signals = result?.diagnostics;
 const row = { reference: ref, hypothesis: request.hypothesis, status: result?.status ?? recovery?.lifecycle ?? "incomplete",
  scope: request.scope?.kind, kind: request.search ? "search" : "single", source: compact(source),
  pipeline: compact(request.pipeline), cv: compact(request.cv), measurementKind: invocation.measurement?.kind,
  metrics: compact(result?.metrics), requestedFolds: result?.requestedFolds, completedFolds: result?.completedFolds,
  signals: signals ? Object.fromEntries(["kind", "proxyEvidence", "foldSpread", "fitSeconds", "ranking", "stability"].map(key => [key, compact(signals[key])])) : undefined,
  championComparison: compact(result?.championComparison), searchComparisons: compact(report?.comparison),
  cost: compact(report?.cost ?? { durationSeconds: result?.durationSeconds, consumedSeconds: recovery?.consumedSeconds }),
  origin: compact({ pipelineRunId: recovery?.originPipelineRunId, stageInvocationId: recovery?.originStageInvocationId }),
  evidenceStatus: "historical_summary_requires_verification", authoritativeForCurrentRun: false };
 return { row, request, source, result, invocation };
}
/** Roots may be direct trial parents or the task's parent of run directories. */
export function experimentHistory(roots: readonly string[], origin: KnowledgeOrigin, offset = 0, limit = 8) {
 if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error("Invalid bounded history page");
 if (roots.length > 8) throw new Error("Too many history roots");
 const refs: ExperimentReference[] = [];
 const seen = new Set<string>();
 let omitted = 0;
 const children = (path: string) => {
  const entries = readdirSync(safePath(path), { withFileTypes: true });
  if (entries.length > 200) throw new Error("History root exceeds 200 entries; select narrower roots");
  return entries.filter(entry => entry.isDirectory() && identifier.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
 };
 const add = (ref: ExperimentReference) => {
  const path = experimentDirectory(roots, ref);
  if (!seen.has(path)) { seen.add(path); refs.push(ref); }
 };
 roots.forEach((root, rootIndex) => {
  if (!existsSync(root)) return;
  for (const entry of children(root)) {
   const path = safePath(join(root, entry.name));
   if (existsSync(join(path, "invocation.json"))) add({ rootIndex, id: entry.name });
   else for (const trial of children(path)) {
    if (existsSync(join(path, trial.name, "invocation.json"))) add({ rootIndex, run: entry.name, id: trial.name });
   }
  }
 });
 if (refs.length > 1000) throw new Error("History exceeds 1000 trials; select narrower roots");
 const rows = [];
 for (const ref of refs) {
  try { rows.push(load(roots, origin, ref).row); } catch { omitted++; }
 }
 const experiments = rows.slice(offset, offset + limit);
 while (Buffer.byteLength(JSON.stringify(experiments)) > 48 * 1024) experiments.pop();
 return { experiments, total: rows.length, omitted,
  nextOffset: offset + experiments.length < rows.length ? offset + experiments.length : null,
  limitation: "Prior work only. Raw scores across different folds or objectives are not paired evidence; no selection is performed." };
}
export function compareExperiments(roots: readonly string[], origin: KnowledgeOrigin, left: ExperimentReference, right: ExperimentReference, repository?: string) {
 const a = load(roots, origin, left), b = load(roots, origin, right);
 const changes = ["module", "factory", "parameters", "estimatorParams"].flatMap(field => {
  const before = a.request.pipeline?.[field] ?? null, after = b.request.pipeline?.[field] ?? null;
  return digest(JSON.stringify(before)) === digest(JSON.stringify(after)) ? [] : [{ field, before: compact(before), after: compact(after) }];
 });
 const paired = (trial: typeof a, other: typeof a) => {
  const receipt = trial.result?.championComparison;
  // Retain the original direction and receipts; never infer a paired result from raw means.
  return receipt && other.source?.commit && receipt.championCommit === other.source.commit
   && receipt.championExperimentId === other.row.reference.id ? compact(receipt) : null;
 };
 let code: Record<string, unknown> = { available: false, reason: "Frozen source revisions or controller-selected repository unavailable" };
 if (repository && /^[a-f0-9]{40,64}$/.test(a.source?.commit ?? "") && /^[a-f0-9]{40,64}$/.test(b.source?.commit ?? "")) {
  const result = spawnSync("git", ["-C", safePath(repository), "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", a.source.commit, b.source.commit, "--", "."],
   { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    timeout: 3000, maxBuffer: 16 * 1024, encoding: "utf8" });
  code = result.error || result.status !== 0 ? { available: false, reason: "Diff unavailable or exceeds 16 KiB; inspect frozen source revisions" }
   : { available: true, fromCommit: a.source.commit, toCommit: b.source.commit, patch: result.stdout };
 }
 return { left: a.row, right: b.row, pipelineChanges: changes, code,
  sourceChanged: a.source && b.source ? a.source.tree !== b.source.tree || a.source.commit !== b.source.commit : null,
  cvChanged: digest(JSON.stringify(a.request.cv)) !== digest(JSON.stringify(b.request.cv)),
  objectiveChanged: digest(JSON.stringify(a.invocation.measurement?.selection ?? a.invocation.measurement?.kind ?? null)) !== digest(JSON.stringify(b.invocation.measurement?.selection ?? b.invocation.measurement?.kind ?? null)),
  pairedComparisons: { leftAgainstRight: paired(a, b), rightAgainstLeft: paired(b, a) },
  limitation: "Source identity and parameter differences describe changes, not their causal effect. Only retained paired receipts support paired claims; no fit or selection is performed." };
}
