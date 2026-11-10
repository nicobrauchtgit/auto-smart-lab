/** Kernel-backed claims and process birth identities; no leases based on silence. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { libproc } from "./sampler.js";
import { randomUUID } from "node:crypto";

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
export function claimWorkspace(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const fd = openSync(join(directory, ".service.lock"), "a", 0o600);
  if (libc.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    throw new Error(`Training workspace is owned by another service: ${directory}. Close that service before retrying.`);
  }
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}
export interface ProcessIdentity { pid: number; pgid: number; birth: string; state: string }
const darwin = process.platform === "darwin" ? dlopen("/usr/lib/libproc.dylib", {
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
}) : undefined;
export function processIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (darwin) {
    const buffer = new Uint8Array(136);
    if (darwin.symbols.proc_pidinfo(pid, 3, 0n, ptr(buffer), buffer.length) !== 136) return undefined;
    const view = new DataView(buffer.buffer);
    return { pid, pgid: view.getUint32(100, true), state: view.getUint32(4, true) === 5 ? "Z" : "R",
      birth: `darwin:${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}` };
  }
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, pgid: Number(fields[2]), state: fields[0],
      birth: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}` };
  } catch { return undefined; }
}
export function ownedProcessAlive(identity?: ProcessIdentity): boolean {
  if (!identity) return false;
  const current = processIdentity(identity.pid);
  return !!current && current.birth === identity.birth && current.pgid === identity.pgid && !["Z", "X"].includes(current.state);
}
/** A surviving descendant blocks restart even after the group leader exits. */
export function liveGroup(pgid: number): ProcessIdentity[] {
  if (pgid <= 0) return [];
  if (process.platform === "darwin") return (libproc()?.groupPids(pgid) ?? []).map(pid => processIdentity(pid))
    .filter((p): p is ProcessIdentity => !!p && p.state !== "Z");
  if (process.platform !== "linux") return [];
  return readdirSync("/proc").filter(name => /^\d+$/.test(name))
    .map(name => processIdentity(Number(name))).filter((p): p is ProcessIdentity => !!p && p.pgid === pgid && !["Z", "X"].includes(p.state));
}
export function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    // Ensure ownership and lifecycle writes reach disk before launch/control.
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
