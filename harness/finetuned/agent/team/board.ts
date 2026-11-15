/** Shared finetuned message board. Controller paths and identity never come from tool arguments. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { statePath, REPO_ROOT } from "../paths.js";
import type { FindingEntry, FindingKind, FindingRef } from "./contracts.js";
import { appendRecords, findingProblem, readFindings } from "./journal.js";
import { createFindings } from "./findings.js";

export const boardPath = (root = statePath(REPO_ROOT)) => join(root, "findings", "journal.jsonl");
export async function assertBoardDestination(root: string) {
 for (const path of [root, join(root, "findings"), boardPath(root), `${boardPath(root)}.lock`]) {
  try {if ((await lstat(path)).isSymbolicLink()) throw new Error("Board paths must not be symbolic links");}
  catch (error: any) {if (error.code !== "ENOENT") throw error;}
 }
}
export interface BoardActor {
 taskId: string; datasetSha256: string; author: FindingEntry["author"]; producerModel?: string;
}
export interface BoardQuery {
 since?: number; limit?: number; taskId?: string; includeOtherTasks?: boolean; kinds?: FindingKind[];
 runId?: string; datasetSha256?: string; text?: string; ids?: string[];
}
export interface Contribution { kind: Exclude<FindingKind, "result">; title: string; text: string; refs?: FindingRef[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createBoard(root = statePath(REPO_ROOT), record?: (event: string, payload: Record<string, unknown>) => void) {
 const path = boardPath(root), references = createFindings(root);
 const read = async (taskId: string, query: BoardQuery = {}) => {
  await assertBoardDestination(root);
  const since = query.since ?? 0, limit = query.limit ?? 12;
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
   query.kinds?.some(kind => !["fact", "idea", "result", "defect", "decision"].includes(kind)) ||
   (query.text?.length ?? 0) > 500 || (query.ids?.length ?? 0) > 100) throw new Error("Invalid board query");
  const view = await readFindings(path);
  const matches = (entry: FindingEntry) => (query.taskId ? entry.taskId === query.taskId : query.includeOtherTasks || entry.taskId === taskId) &&
   (!query.kinds || query.kinds.includes(entry.kind)) && (!query.runId || entry.author.runId === query.runId) &&
   (!query.datasetSha256 || entry.datasetSha256 === query.datasetSha256) && (!query.ids || query.ids.includes(entry.id)) &&
   (!query.text || `${entry.title} ${entry.text}`.toLowerCase().includes(query.text.toLowerCase()));
  const matching = view.entries.filter(matches), ids = new Set(matching.map(row => row.id));
  const page = view.records.filter(row => row.cursor > since && ids.has(row.id)).slice(0, limit);
  const entries = await Promise.all(page.filter((row): row is FindingEntry => "kind" in row).map(async entry => ({...entry,
   evidence: await references.referenceStatus(entry.taskId!, entry.refs, view.entries),
   superseded: view.resolutions.some(row => row.id === entry.id) })));
  const cursor = page.length === limit ? page.at(-1)!.cursor : view.cursor;
  const result = {entries, resolutions: page.filter(row => "status" in row), cursor, incompleteTail: view.incompleteTail};
  record?.("board_read", {task_id: taskId, selected_ids: entries.map(row => row.id), cursor, limit,
   stale: entries.flatMap(row => row.evidence.staleRefs), unresolved: entries.flatMap(row => row.evidence.unresolvedRefs)});
  return result;
 };
 const write = async (actor: BoardActor, input: Contribution, requestId: string, signal?: AbortSignal) => {
  await assertBoardDestination(root);
  if (Object.keys(input).some(key => !["kind", "title", "text", "refs"].includes(key))) throw new Error("Unexpected contribution field");
  if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new Error("Invalid write request identity");
  const entry: FindingEntry = {...input, refs: input.refs ?? [], schemaVersion: 2, taskId: actor.taskId,
   author: actor.author, datasetSha256: actor.datasetSha256, ...(actor.producerModel ? {producerModel: actor.producerModel} : {}),
   requestId: hash([actor.taskId, actor.author, requestId]), id: "pending", cursor: 0};
  const problem = findingProblem(entry);
  if (problem) throw new Error(`Finding rejected: ${problem}`);
  if ((input.kind as FindingKind) === "result") throw new Error("Results require harness measurements");
  if (input.kind === "decision" && actor.author.role !== "lead") throw new Error("Only the lead records decisions");
  if (input.kind === "defect" && (actor.author.role !== "validation" || !entry.refs.some(ref => "experiment" in ref || "check" in ref))) throw new Error("Defect requires validation evidence");
  let saved: FindingEntry | undefined;
  await appendRecords(path, view => {
   saved = view.entries.find(row => row.requestId === entry.requestId);
   if (saved) {
    if (hash([saved.kind, saved.title, saved.text, saved.refs]) !== hash([entry.kind, entry.title, entry.text, entry.refs])) throw new Error("Write request identity reused with different content");
    return [];
   }
   saved = {...entry, id: `finding-${entry.requestId}` , cursor: view.cursor + 1};
   return [saved];
  }, signal);
  record?.("board_write", {id: saved!.id, task_id: actor.taskId, kind: input.kind, request_id: entry.requestId});
  return saved!;
 };
 const resolve = async (actor: BoardActor, id: string, supersededBy?: string, signal?: AbortSignal) => {
  await assertBoardDestination(root);
  await appendRecords(path, view => {
   const entry = view.entries.find(row => row.id === id);
   if (!entry || entry.author.role !== actor.author.role || entry.author.runId !== actor.author.runId || entry.author.invocationId !== actor.author.invocationId)
    throw new Error("Only the original author may supersede a finding; write a reply to disagree");
   if (supersededBy && (supersededBy === id || !view.entries.some(row => row.id === supersededBy))) throw new Error("Unknown replacement finding");
   if (view.resolutions.some(row => row.id === id && row.supersededBy === supersededBy)) return [];
   return [{id, status: "superseded", ...(supersededBy ? {supersededBy} : {}), cursor: 0}];
  }, signal);
  record?.("board_resolve", {id, superseded_by: supersededBy, task_id: actor.taskId});
  return {id, status: "superseded" as const};
 };
 const recall = async (taskId: string, text: string) => {
  await assertBoardDestination(root);
  const view = await readFindings(path);
  const superseded = new Set(view.resolutions.map(row => row.id));
  const active = view.entries.filter(row => !superseded.has(row.id));
  const tokens = [...new Set(text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])].slice(0, 128);
  const same = active.filter(row => row.taskId === taskId).slice(-8);
  const ranked = active.filter(row => row.taskId !== taskId).map(row => ({row, score: tokens.filter(token => `${row.title} ${row.text}`.toLowerCase().includes(token)).length}))
   .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.row.cursor - a.row.cursor).slice(0, 4).map(item => item.row);
  const chosen = [...same, ...ranked];
  const entries = await Promise.all(chosen.map(async row => {
   const status = await references.referenceStatus(row.taskId!, row.refs.slice(0, 20), view.entries);
   const short = (values: string[]) => values.slice(0, 2).map(value => value.slice(0, 120));
   return {id: row.id, taskId: row.taskId, datasetSha256: row.datasetSha256.slice(0, 80),
    author: {...row.author, runId: row.author.runId.slice(0, 80), invocationId: row.author.invocationId.slice(0, 80)},
    producerModel: (row.producerModel ?? "unknown").slice(0, 120), kind: row.kind, title: row.title, text: row.text.slice(0, 200),
    evidence: {staleRefs: short(status.staleRefs), unresolvedRefs: short(status.unresolvedRefs),
     omitted: Math.max(0, status.staleRefs.length - 2) + Math.max(0, status.unresolvedRefs.length - 2), uncheckedRefs: Math.max(0, row.refs.length - 20)}};
  }));
  const result = {entries, cursor: view.cursor, omitted: active.length - chosen.length, limits: {sameTask: 8, otherTasks: 4, chars: 200, tokens: 128, totalChars: 12000}, incompleteTail: view.incompleteTail};
  while (JSON.stringify(result).length > result.limits.totalChars && entries.length) {entries.pop(); result.omitted++;}
  record?.("board_recall", {task_id: taskId, selected_ids: entries.map(row => row.id), cursor: result.cursor, omitted: result.omitted, limits: result.limits});
  return result;
 };
 return {path, read, write, resolve, recall};
}

/** Explicit allowlist: no holdout, targets, raw errors, pipeline prose or arbitrary receipt fields. */
export async function postTrialResult(root: string, actor: BoardActor, trial: {
 experimentId: string; source: string; status: string; metric?: string; score?: number;
 foldScores: number[]; elapsedSeconds: number; peakRssMb?: number;
 sourceCommit?: string; sourceTree?: string; scope?: string; promotionEligible?: boolean; requestedFolds?: number; completedFolds?: number;
}) {
 await assertBoardDestination(root);
 const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
 const scores = trial.foldScores.filter(finite);
 const mean = scores.length ? scores.reduce((a,b) => a+b, 0) / scores.length : undefined;
 const sd = mean !== undefined ? Math.sqrt(scores.reduce((sum, value) => sum + (value-mean)**2, 0) / Math.max(1, scores.length-1)) : undefined;
 const measurement = {sourceCommit: trial.sourceCommit, sourceTree: trial.sourceTree, scope: trial.scope, promotionEligible: trial.promotionEligible, requestedFolds: trial.requestedFolds, completedFolds: trial.completedFolds, experimentId: trial.experimentId, source: trial.source, status: trial.status,
  metric: trial.metric, ...(finite(trial.score) ? {score: trial.score} : {}), foldScores: scores, mean, sd,
  elapsedSeconds: finite(trial.elapsedSeconds) ? trial.elapsedSeconds : undefined, ...(finite(trial.peakRssMb) ? {peakRssMb: trial.peakRssMb} : {})};
 const id = `result-${hash([actor.taskId, actor.datasetSha256, trial.source, trial.experimentId, trial.status])}`;
 const entry: FindingEntry = {schemaVersion: 2, taskId: actor.taskId, id, cursor: 0, kind: "result", author: actor.author,
  ...(actor.producerModel ? {producerModel: actor.producerModel} : {}), datasetSha256: actor.datasetSha256,
  title: `Trial ${trial.experimentId}: ${trial.status}`.slice(0,100), text: JSON.stringify({status: trial.status, metric: trial.metric, mean, sd, elapsedSeconds: measurement.elapsedSeconds}).slice(0,800),
  refs: [{experiment: trial.experimentId}], measurement};
 const problem = findingProblem(entry); if (problem) throw new Error(problem);
 await appendRecords(boardPath(root), view => view.entries.some(row => row.id === id) ? [] : [entry]);
 return entry;
}
