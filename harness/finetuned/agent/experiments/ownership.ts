/** Kernel-backed claims and process birth identities; no leases based on silence. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { libproc, type LinuxProcess } from "./sampler.js";
import { randomUUID } from "node:crypto";

// Loaded on first claim, so importing this module never fails on a libc it cannot open.
let libc: { symbols: { flock(fd: number, operation: number): number } } | undefined;
function flock(fd: number, operation: number): number {
  libc ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  return libc.symbols.flock(fd, operation);
}
export function claimWorkspace(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const fd = openSync(join(directory, ".service.lock"), "a", 0o600);
  if (flock(fd, 2 | 4) !== 0) {
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
      birth: `${bootId()}:${fields[19]}` };
  } catch { return undefined; }
}
let boot: string | undefined;
/** Constant until reboot; read once rather than for every identity check. */
function bootId(): string {
  return boot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
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

/** The birth identity a `/proc` scan implies for a process: the string `processIdentity` builds. */
export function birthOf(startTicks: number): string {
  return `${bootId()}:${startTicks}`;
}

/**
 * Every live process of one owner, by birth identity, from one scan.
 *
 * Roots are the processes tracked earlier that are still the same processes,
 * plus the process group while it is verifiably ours: a group ID is not reused
 * while any process carries it, so a group that was ours and has not been seen
 * empty since, or that a tracked member still belongs to, is still ours.
 * Descendants of any root join through their parent link. Tracking survives the
 * leader's exit and a descendant's `setsid` after its parent has gone, because
 * each member stays tracked by its own birth identity.
 */
export function ownedMembers(pgid: number, processes: readonly LinuxProcess[], tracked: Iterable<ProcessIdentity>, groupHeld: boolean):
  { members: LinuxProcess[]; tracked: ProcessIdentity[]; groupHeld: boolean } {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const roots = new Set<number>();
  for (const identity of tracked) {
    const current = byPid.get(identity.pid);
    if (current && birthOf(current.startTicks) === identity.birth) roots.add(current.pid);
  }
  const group = pgid > 0 ? processes.filter(p => p.pgid === pgid) : [];
  const held = group.length > 0 && (groupHeld || group.some(p => roots.has(p.pid)));
  if (held) for (const p of group) roots.add(p.pid);
  for (let changed = roots.size > 0; changed;) {
    changed = false;
    for (const p of processes) if (!roots.has(p.pid) && roots.has(p.ppid)) { roots.add(p.pid); changed = true; }
  }
  const members = processes.filter(p => roots.has(p.pid));
  return { members, groupHeld: held,
    tracked: members.map(p => ({ pid: p.pid, pgid: p.pgid, birth: birthOf(p.startTicks), state: "R" })) };
}

/**
 * Stop targets from a scan, each confirmed against a fresh read of its PID.
 * A process whose birth differs from the scan's is a different process that
 * reused the PID after the scan, and is dropped.
 */
export function confirmedTargets(processes: readonly LinuxProcess[], identityOf: (pid: number) => ProcessIdentity | undefined = processIdentity): ProcessIdentity[] {
  return processes.flatMap(p => {
    const current = identityOf(p.pid);
    return current && current.birth === birthOf(p.startTicks) && !["Z", "X"].includes(current.state) ? [current] : [];
  });
}

/** The same process as captured, whichever group it has moved to since. */
export function sameProcessAlive(identity?: ProcessIdentity): boolean {
  if (!identity) return false;
  const current = processIdentity(identity.pid);
  return !!current && current.birth === identity.birth && !["Z", "X"].includes(current.state);
}
