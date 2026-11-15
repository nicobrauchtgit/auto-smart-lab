/** Deterministic import of direct per-task finetuned journals only; originals are never changed. */
import { readdir, lstat, readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { appendRecords, readFindings, type FindingRecord } from "./journal.js";
import { assertBoardDestination, boardPath } from "./board.js";
import type { FindingEntry } from "./contracts.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function inventoryJournals(root: string) {
 const sources: {taskId: string; path: string; sha256: string}[] = [];
 for (const task of await readdir(root, {withFileTypes: true}).catch((error: any) => {if (error.code === "ENOENT") return []; throw error;})) {
  if (!task.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(task.name) || ["findings", "solutions", "scout-dry-run"].includes(task.name)) continue;
  const path = join(root, task.name, "findings", "journal.jsonl");
  try {
   if ((await lstat(join(root, task.name, "findings"))).isSymbolicLink() || !(await lstat(path)).isFile()) throw new Error("Legacy journal must be a regular file");
   sources.push({taskId: task.name, path, sha256: hash(await readFile(path))});
  } catch (error: any) {if (error.code !== "ENOENT") throw error;}
 }
 return sources.sort((a,b) => a.taskId.localeCompare(b.taskId));
}
/** Shared preflight uses this non-destructively. Changed legacy sources require another explicit import. */
export async function checkBoardHistory(root: string) {
 const sources = await inventoryJournals(root);
 const receipt = await importReceipt(root);
 if (!sources.length && !receipt) return;
 if (!receipt || receipt.sources.some((item: any) => !sources.some(source => source.taskId === item.taskId)))
  throw new Error("Missing legacy findings source or import receipt; restore the original journals");
 if (sources.some(source => !receipt.sources.some((item: any) => item.taskId === source.taskId && item.sha256 === source.sha256)) || receipt.rejected.length)
  throw new Error("Legacy findings need import; stop old writers and run findings-import --apply");
 const board = await readFindings(boardPath(root));
 for (const source of sources) {
  const original = await readFindings(source.path);
  for (const entry of original.entries) {
   const imported = board.entries.find(row => row.id === importedId(source.taskId, entry.id));
   if (!imported || imported.legacy?.recordSha256 !== hash(JSON.stringify(entry))) throw new Error("Imported finding is missing or differs from source");
  }
  for (const event of original.resolutions) if (!board.resolutions.some(row => row.id === importedId(source.taskId, event.id) &&
   row.supersededBy === (event.supersededBy ? importedId(source.taskId, event.supersededBy) : undefined))) throw new Error("Imported resolution is missing from board");
 }
}
const importedId = (taskId: string, id: string) => `legacy-${hash(JSON.stringify([taskId,id]))}`;
async function importReceipt(root: string): Promise<any | undefined> {
 try {return JSON.parse(await readFile(join(root, "findings", "import-receipt.json"), "utf8"));}
 catch (error: any) {if (error.code === "ENOENT") return undefined; throw error;}
}
/** Refuse a live old writer before cutover; no provider calls or process mutation. */
export async function assertNoBoardWriters() {
 for (const pid of await readdir("/proc")) {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
  let command = "";
  try {command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");} catch {continue;}
  if (/\bbun\s+.*(?:pipeline_cli|lead_cli|budget_probe)\.ts\b/.test(command)) throw new Error(`Stop active pipeline/scout writer PID ${pid} before importing`);
 }
}
export async function importBoard(root: string, apply = false, activeCheck = assertNoBoardWriters) {
 await assertBoardDestination(root);
 if (apply) await activeCheck();
 const sources = await inventoryJournals(root);
 const previous = await importReceipt(root);
 const report = {schemaVersion: 1, applied: apply, sources: sources.map(({taskId, sha256}) => ({taskId, sha256})), imported: 0, skipped: 0,
  rejected: [] as {taskId: string; reason: string}[], warnings: [] as {taskId: string; reason: string}[],
  mappings: [] as {taskId: string; oldCursor: number; cursor: number; id: string}[]};
 for (const source of previous?.sources ?? []) if (!sources.some(row => row.taskId === source.taskId)) {
  report.sources.push(source);
  report.rejected.push({taskId: source.taskId, reason: "previously imported source journal is missing; restore the original"});
 }
 const target = await readFindings(boardPath(root));
 const pending: FindingRecord[] = [];
 for (const source of sources) {
  try {
   const view = await readFindings(source.path);
   if (view.incompleteTail) report.warnings.push({taskId: source.taskId, reason: "incomplete tail retained in original; complete records imported"});
   const ids = new Map(view.entries.map(row => [row.id, importedId(source.taskId, row.id)]));
   for (const row of view.records) {
    const id = ids.get(row.id)!;
    const provenance = {taskId: source.taskId, source: relative(root, source.path), cursor: row.cursor, id: row.id, recordSha256: hash(JSON.stringify(row))};
    const mapped: FindingRecord = "kind" in row ? {...row, schemaVersion: 2, taskId: source.taskId, id, cursor: 0,
     refs: row.refs.map(ref => "entry" in ref ? {entry: ids.get(ref.entry) ?? importedId(source.taskId, ref.entry)} : ref), legacy: provenance}
     : {...row, id, cursor: 0, ...(row.supersededBy ? {supersededBy: ids.get(row.supersededBy)!} : {})};
    const existing = target.records.find(item => "kind" in row ? "kind" in item && item.id === id : "status" in item && item.id === id && item.supersededBy === (mapped as any).supersededBy);
    if (existing && "kind" in existing && existing.legacy?.recordSha256 !== provenance.recordSha256) throw new Error("Previously imported record changed");
    if (existing) {report.skipped++; report.mappings.push({taskId: source.taskId, oldCursor: row.cursor, cursor: existing.cursor, id});}
    else {pending.push(mapped); report.mappings.push({taskId: source.taskId, oldCursor: row.cursor, cursor: target.cursor + pending.length, id});}
   }
  } catch {report.rejected.push({taskId: source.taskId, reason: "malformed complete journal; original retained"});}
 }
 if (apply) {
  // Recheck input hashes and sessions immediately before the atomic append.
  await activeCheck();
  for (const source of sources) if (hash(await readFile(source.path)) !== source.sha256) throw new Error("Legacy journal changed during import");
  const appended = await appendRecords(boardPath(root), view => pending.filter(row => "kind" in row ? !view.entries.some(item => item.id === row.id) :
   !view.resolutions.some(item => item.id === row.id && item.supersededBy === row.supersededBy)));
  report.imported = appended.length;
  // Resolve mapping cursors against committed records (another importer may have won the lock).
  const committed = await readFindings(boardPath(root));
  const mappedTasks = new Set(report.mappings.map(row => row.taskId));
  const originals = new Map(await Promise.all(sources.filter(source => mappedTasks.has(source.taskId))
   .map(async source => [source.taskId, (await readFindings(source.path)).records] as const)));
  for (const mapping of report.mappings) {
   const row = originals.get(mapping.taskId)!.find(row => row.cursor === mapping.oldCursor)!;
   mapping.cursor = committed.records.find(item => "kind" in row ? "kind" in item && item.id === mapping.id :
    "status" in item && item.id === mapping.id && item.supersededBy === (row.supersededBy ? importedId(mapping.taskId, row.supersededBy) : undefined))!.cursor;
  }
  const receipt = join(root, "findings", "import-receipt.json");
  await mkdir(join(root, "findings"), {recursive: true});
  const temp = `${receipt}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(report, null, 2)); await rename(temp, receipt);
 } else report.imported = pending.length;
 return report;
}
