import { dlopen, FFIType } from "bun:ffi";
import { open, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FindingEntry, FindingResolution } from "./contracts.js";
export type FindingRecord = FindingEntry | FindingResolution;
const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
 flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
function validRef(ref: unknown): boolean {
 if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
 const value = ref as Record<string, unknown>;
 const shapes = [ ["experiment"], ["file", "line", "commit"], ["check", "experiment", "sha256"], ["url"], ["profile"], ["entry"] ];
 return shapes.some(keys => Object.keys(value).every(key => keys.includes(key)) &&
  (keys[0] === "file" ? typeof value.file === "string" && Number.isSafeInteger(value.line) && Number(value.line) > 0 && (value.commit === undefined || typeof value.commit === "string") :
   keys[0] === "check" ? typeof value.check === "string" && typeof value.sha256 === "string" && (value.experiment === undefined || typeof value.experiment === "string") : typeof value[keys[0]] === "string"));
}
export function validateFinding(entry: FindingEntry): void {
 if (typeof entry.id !== "string" || !entry.id || !["fact", "idea", "result", "defect", "decision"].includes(entry.kind) ||
  typeof entry.title !== "string" || !entry.title || entry.title.length > 100 || typeof entry.text !== "string" || !entry.text || entry.text.length > 800 ||
  !Array.isArray(entry.refs) || !entry.refs.every(validRef) || typeof entry.datasetSha256 !== "string" || !entry.datasetSha256 || typeof entry.author?.runId !== "string" || !entry.author.runId || typeof entry.author.invocationId !== "string" || !entry.author.invocationId ||
  !["lead", "data", "ideas", "validation"].includes(entry.author.role)) throw new Error("Malformed complete finding record");
}
export async function readFindings(path: string) {
 let bytes: Buffer;
 try { bytes = await readFile(path); } catch (e: any) { if (e.code === "ENOENT") return { entries: [] as FindingEntry[], resolutions: [] as FindingResolution[], records: [] as FindingRecord[], incompleteTail: false, validBytes: 0, cursor: 0 }; throw e; }
 const end = bytes.lastIndexOf(10) + 1;
 const records = bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map((line, i): FindingRecord => {
  const record = JSON.parse(line);
  if (!record.id || record.cursor !== i + 1) throw new Error("Malformed finding cursor");
  if (record.status === "superseded") {
   if (record.supersededBy !== undefined && (typeof record.supersededBy !== "string" || !record.supersededBy)) throw new Error("Malformed replacement finding ID");
   if (Object.keys(record).some(key => !["cursor", "id", "status", "supersededBy"].includes(key))) throw new Error("Malformed finding resolution");
  } else validateFinding(record);
  return record;
 });
 for (const record of records) if ("status" in record) {
  const preceding = records.filter((row): row is FindingEntry => "kind" in row && row.cursor < record.cursor);
  if (!preceding.some(row => row.id === record.id) || (record.supersededBy && !preceding.some(row => row.id === record.supersededBy && row.id !== record.id))) throw new Error("Resolution refers to a missing finding");
 }
 return { records, entries: records.filter((row): row is FindingEntry => "kind" in row),
  resolutions: records.filter((row): row is FindingResolution => "status" in row),
  incompleteTail: end < bytes.length, validBytes: end, cursor: records.length };
}

/** Separate kernel flock; cancellation waits/retries and process exit releases it. */
async function appendRecords(path: string, build: (view: Awaited<ReturnType<typeof readFindings>>) => FindingRecord[], signal?: AbortSignal) {
 await mkdir(dirname(path), {recursive: true});
 const lock = await open(`${path}.lock`, "a", 0o600);
 try {
  while (libc.symbols.flock(lock.fd, 2 | 4) !== 0) {signal?.throwIfAborted(); await delay(25, undefined, {signal});}
  signal?.throwIfAborted();
  const view = await readFindings(path);
  const records = build(view).map((record, i) => ({...record, cursor: view.cursor + i + 1}));
  const file = await open(path, "a+");
  try {
   if (view.incompleteTail) await file.truncate(view.validBytes);
   await file.write(records.map(record => JSON.stringify(record) + "\n").join(""));
   await file.sync();
  } finally {await file.close();}
  return records;
 } finally {await lock.close();}
}
export async function appendFindings(path: string, inputs: Omit<FindingEntry, "id" | "cursor">[], signal?: AbortSignal): Promise<FindingEntry[]> {
 return await appendRecords(path, () => inputs.map(input => {
  const entry = {...input, id: randomUUID(), cursor: 0};
  validateFinding(entry);
  if (input.kind === "result") throw new Error("Results require a harness record adapter; agent text is not measurement evidence");
  if (input.kind === "defect" && (input.author.role !== "validation" || !input.refs.some(ref => "experiment" in ref || "check" in ref))) throw new Error("Defect requires snapshot/check evidence");
  return entry;
 }), signal) as FindingEntry[];
}
export async function resolveFinding(path: string, event: Omit<FindingResolution, "cursor">, actor: FindingEntry["author"]["role"], signal?: AbortSignal): Promise<FindingResolution> {
 const records = await appendRecords(path, view => {
  const entry = view.entries.find(row => row.id === event.id);
  if (event.supersededBy !== undefined && (typeof event.supersededBy !== "string" || !event.supersededBy)) throw new Error("Malformed replacement finding ID");
  if (Object.keys(event).some(key => !["id", "status", "supersededBy"].includes(key))) throw new Error("Malformed finding resolution");
  if (!entry || entry.author.role !== actor || event.status !== "superseded") throw new Error("Only the finding's author may supersede it");
  if (event.supersededBy && !view.entries.some(row => row.id === event.supersededBy && row.id !== event.id)) throw new Error("Unknown replacement finding");
  return [{...event, cursor: 0}];
 }, signal);
 return records[0] as FindingResolution;
}
