import { dlopen, FFIType } from "bun:ffi";
import { open, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { FindingEntry } from "./contracts.js";

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
 flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
export async function readFindings(path: string): Promise<{ entries: FindingEntry[]; incompleteTail: boolean; validBytes: number }> {
 let bytes: Buffer;
 try { bytes = await readFile(path); } catch (e: any) { if (e.code === "ENOENT") return { entries: [], incompleteTail: false, validBytes: 0 }; throw e; }
 const end = bytes.lastIndexOf(10) + 1;
 const entries = bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map(line => {
  const entry = JSON.parse(line) as FindingEntry;
  if (!entry.id || !Number.isSafeInteger(entry.cursor) || typeof entry.text !== "string" || !Array.isArray(entry.refs)) throw new Error("Malformed complete finding record");
  return entry;
 });
 for (let i = 0; i < entries.length; i++) if (entries[i].cursor !== i + 1) throw new Error("Nonsequential findings cursor");
 return { entries, incompleteTail: end < bytes.length, validBytes: end };
}

/** Wait on contention; flush the complete append before returning. Never alter training locks. */
export async function appendFindings(path: string, inputs: Omit<FindingEntry, "id" | "cursor">[], signal?: AbortSignal): Promise<FindingEntry[]> {
 await mkdir(dirname(path), { recursive: true });
 const lock = await open(`${path}.lock`, "a", 0o600);
 try {
  while (libc.symbols.flock(lock.fd, 2 | 4) !== 0) {
   signal?.throwIfAborted();
   await delay(25, undefined, { signal });
  }
 } catch (error) { await lock.close(); throw error; }
 try {
  signal?.throwIfAborted();
  const view = await readFindings(path);
  const entries = inputs.map((input, i) => {
   if (!input.text || input.text.length > 800 || input.title.length > 100 || input.kind === "result") throw new Error("Invalid scout finding (results require harness records)");
   if (input.kind === "defect" && (input.author.role !== "validation" || !input.refs.some(ref => "experiment" in ref || "check" in ref))) throw new Error("Defect requires snapshot/check evidence");
   return { ...input, id: randomUUID(), cursor: view.entries.length + i + 1 };
  });
  const file = await open(path, "a+");
  try {
   if (view.incompleteTail) await file.truncate(view.validBytes);
   await file.write(entries.map(entry => JSON.stringify(entry) + "\n").join(""));
   await file.sync();
  } finally { await file.close(); }
  return entries;
 } finally { await lock.close(); }
}
