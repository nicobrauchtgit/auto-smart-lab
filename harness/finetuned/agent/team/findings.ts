/** Read-only derived views and append adapters. Never executes agent code. */
import { readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { REPO_ROOT, statePath } from "../paths.js";
import { appendFindings, readFindings, resolveFinding } from "./journal.js";
import type { FindingEntry, FindingKind, FindingRef, FindingResolution, FindingsReader, FindingsStatus, TeamRole } from "./contracts.js";
import { createTrialResolver, taskTrialRoots, trialBound, type TrialResolver } from "./trials.js";
const kinds: FindingKind[] = ["fact", "idea", "result", "defect", "decision"];
/** Contract page size: at most 12 new titles per status. */
export const FINDINGS_PAGE = 12;
function cursor(value: number) {if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid findings cursor");}
const escapes = (delta: string) => delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta);
/**
 * Contract status plus experiment and commit-bound references this reader
 * could not check (no trial record or repository). Stale references (record
 * found, source missing or changed) are in `staleRefs`.
 */
export type FindingsStatusView = FindingsStatus & { unresolvedRefs: string[] };
/**
 * `trials` resolves experiment and commit-bound references for a task;
 * default: stream B's resolver over the task's training roots and the shared
 * solutions repository under `root`.
 */
export function createFindings(root = statePath(REPO_ROOT), options: { trials?: (taskId: string) => TrialResolver } = {}) {
 const base = resolve(root);
 const taskRoot = (taskId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Invalid findings task ID");
  return join(base, taskId);
 };
 const resolvers = new Map<string, TrialResolver>();
 const trials = (taskId: string) => {
  if (!resolvers.has(taskId)) resolvers.set(taskId, options.trials?.(taskId) ?? createTrialResolver({roots: () => taskTrialRoots(base, taskId), solutionsRoot: join(base, "solutions")}));
  return resolvers.get(taskId)!;
 };
 const journal = (taskId: string) => join(taskRoot(taskId), "findings/journal.jsonl");
 /** Scout file and profile citations are stored relative to the state root (see bulletRefs). */
 const refStatus = async (taskId: string, refs: FindingRef[], entries: FindingEntry[]) => {
  const missing: string[] = [], unresolved: string[] = [];
  for (const ref of refs) {
   if ("entry" in ref) {if (!entries.some(entry => entry.id === ref.entry)) missing.push(`entry:${ref.entry}`); continue;}
   if ("url" in ref) {if (!/^https?:\/\//.test(ref.url)) missing.push(`url:${ref.url}`); continue;} // No network claim.
   // Experiment records and commit-bound sources resolve through stream B's trial source service.
   if (trialBound(ref)) {
    const label = "file" in ref ? `file:${ref.file}@${ref.commit}` : `experiment:${(ref as {experiment: string}).experiment}`;
    const state = await trials(taskId).status(ref);
    if (state.status === "stale") missing.push(label);
    else if (state.status === "unresolved") unresolved.push(label);
    continue;
   }
   const value = "file" in ref ? ref.file : "check" in ref ? ref.check : "profile" in ref ? ref.profile : "";
   if (!value) continue;
   const candidates = isAbsolute(value) ? [value] : "check" in ref ? [join(base, "solutions", value)] : [join(base, value), join(taskRoot(taskId), value)];
   let found = false;
   for (const candidate of candidates) {
    const path = resolve(candidate);
    if (escapes(relative(base, path))) continue;
    try {
     if (escapes(relative(base, await realpath(path)))) continue;
     if (!(await stat(path)).isFile()) continue;
     if ("check" in ref && createHash("sha256").update(await readFile(path)).digest("hex") !== ref.sha256) continue;
     found = true; break;
    } catch (error: any) {if (error.code !== "ENOENT") throw error;}
   }
   if (!found) missing.push(JSON.stringify(ref));
  }
  return {staleRefs: [...new Set(missing)], unresolvedRefs: [...new Set(unresolved)]};
 };
 const read = async (taskId: string, options: {since?: number; kinds?: FindingKind[]; limit?: number} = {}) => {
  cursor(options.since ?? 0);
  const limit = options.limit ?? FINDINGS_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || options.kinds?.some(kind => !kinds.includes(kind))) throw new Error("Invalid findings filters");
  const view = await readFindings(journal(taskId));
  const selected = view.records.filter(row => row.cursor > (options.since ?? 0) && (!("kind" in row) || !options.kinds || options.kinds.includes(row.kind))).slice(0, limit);
  const entries = selected.filter((row): row is FindingEntry => "kind" in row);
  const refs = await refStatus(taskId, entries.flatMap(entry => entry.refs), view.entries);
  return {entries, resolutions: selected.filter((row): row is FindingResolution => "status" in row),
   cursor: selected.length === limit ? selected.at(-1)!.cursor : view.cursor,
   staleRefs: [...(view.incompleteTail ? ["incomplete-journal-tail"] : []), ...refs.staleRefs], unresolvedRefs: refs.unresolvedRefs};
 };
 const status = async (taskId: string, since = 0): Promise<FindingsStatusView> => {
  cursor(since);
  const view = await readFindings(journal(taskId));
  const superseded = new Set(view.resolutions.map(row => row.id));
  const active = view.entries.filter(row => !superseded.has(row.id));
  const counts: FindingsStatus["counts"] = {};
  for (const row of active) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  const fresh = active.filter(row => row.cursor > since);
  const page = fresh.slice(0, FINDINGS_PAGE);
  const refs = await refStatus(taskId, active.flatMap(row => row.refs), view.entries);
  // A truncated page ends at its last entry so the next status resumes after it.
  return {cursor: fresh.length > page.length ? page.at(-1)!.cursor : view.cursor, counts, newEntries: page.map(({id, title}) => ({id, title})),
   staleRefs: [...(view.incompleteTail ? ["incomplete-journal-tail"] : []), ...refs.staleRefs], unresolvedRefs: refs.unresolvedRefs};
 };
 return {read, status,
  add: async (taskId: string, entry: Omit<FindingEntry, "id" | "cursor">, signal?: AbortSignal) => (await appendFindings(journal(taskId), [entry], signal))[0],
  resolve: (taskId: string, event: Omit<FindingResolution, "cursor">, actor: TeamRole, signal?: AbortSignal) => resolveFinding(journal(taskId), event, actor, signal),
 };
}
export const findingsRead = (...args: Parameters<ReturnType<typeof createFindings>["read"]>) => createFindings().read(...args);
export const findingsStatus = (...args: Parameters<ReturnType<typeof createFindings>["status"]>) => createFindings().status(...args);
export const findingsAdd = (...args: Parameters<ReturnType<typeof createFindings>["add"]>) => createFindings().add(...args);
export const findingsResolve = (...args: Parameters<ReturnType<typeof createFindings>["resolve"]>) => createFindings().resolve(...args);
/** Read-only adapter, re-exported by workspace/findings_reader.ts. */
export function createFindingsReader(root: string): FindingsReader {return {status: createFindings(root).status};}

/**
 * Bounded view of earlier entries for a repeat scout call: same run and
 * dataset fingerprint, not superseded, newest page only, short text.
 */
export async function earlierFindings(path: string, scope: {runId: string; datasetSha256: string}, limits = {entries: FINDINGS_PAGE, chars: 200}) {
 const view = await readFindings(path);
 const superseded = new Set(view.resolutions.map(row => row.id));
 const relevant = view.entries.filter(row => !superseded.has(row.id) && row.author.runId === scope.runId && row.datasetSha256 === scope.datasetSha256);
 const shown = relevant.slice(-limits.entries);
 return {
  lines: shown.map(row => `- [${row.kind}, ${row.author.role}] ${row.text.length > limits.chars ? `${row.text.slice(0, limits.chars).trimEnd()}…` : row.text}`),
  omitted: relevant.length - shown.length, incompleteTail: view.incompleteTail,
 };
}
