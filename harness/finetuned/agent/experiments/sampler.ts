/**
 * CPU and memory for a process group, through libproc.
 *
 * `ps -o time,rss,vsz` fails on Darwin 25 with "requires entitlement", so the
 * usual shell route is not available at all. `proc_pidinfo` with
 * PROC_PIDTASKINFO works for own-user processes and costs under a microsecond,
 * and `proc_listpgrppids` enumerates the group without forking -- the `ps -g`
 * equivalent costs 3.6 ms because it does.
 *
 * The one trap worth stating twice: `pti_total_user` and `pti_total_system` are
 * mach ticks, not nanoseconds. Apple Silicon's timebase is 125/3, so 41.67 ns a
 * tick. Read as nanoseconds, a fully pegged core reports 2.4% and every healthy
 * fit looks deadlocked.
 */

import { readFileSync, readdirSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ResourceSample } from "./types.js";

const PROC_PIDTASKINFO = 4;
const TASKINFO_BYTES = 256;
const MAX_GROUP_PIDS = 512;

interface Libproc {
	taskInfo(pid: number): { rssBytes: number; cpuSeconds: number } | null;
	groupPids(pgid: number): number[];
	/** Nanoseconds per mach tick. 41.666... on Apple Silicon, 1.0 on Intel. */
	tickNanoseconds: number;
}

function open(): Libproc | null {
	if (process.platform !== "darwin") return null;
	try {
		const proc = dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		});
		const system = dlopen("/usr/lib/libSystem.dylib", {
			mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
		});
		const timebase = new Uint32Array(2);
		system.symbols.mach_timebase_info(ptr(timebase));
		const [numerator, denominator] = timebase;
		const tickNanoseconds = denominator > 0 ? numerator / denominator : 1;
		const buffer = new Uint8Array(TASKINFO_BYTES);
		const view = new DataView(buffer.buffer);
		const pids = new Int32Array(MAX_GROUP_PIDS);
		return {
			tickNanoseconds,
			taskInfo(pid) {
				if (proc.symbols.proc_pidinfo(pid, PROC_PIDTASKINFO, 0n, ptr(buffer), TASKINFO_BYTES) <= 0) return null;
				// struct proc_taskinfo: virtual size, resident size, total user, total system.
				const rssBytes = Number(view.getBigUint64(8, true));
				const ticks = view.getBigUint64(16, true) + view.getBigUint64(24, true);
				return { rssBytes, cpuSeconds: cpuSecondsFromTicks(ticks, tickNanoseconds) };
			},
			groupPids(pgid) {
				// Returns the number of pids written, not the number of bytes. Dividing
				// it by four leaves a one-process group reading as an empty one, which
				// looks exactly like a finished fit.
				const found = proc.symbols.proc_listpgrppids(pgid, ptr(pids), pids.byteLength);
				if (found <= 0) return [];
				return Array.from(pids.subarray(0, Math.min(found, pids.length))).filter((pid) => pid > 0);
			},
		};
	} catch {
		// No sampling is a recorded gap in observation, not a failed experiment.
		return null;
	}
}

/** Mach ticks to seconds. Separate and exported because reading it wrong is the classic error. */
export function cpuSecondsFromTicks(ticks: bigint | number, tickNanoseconds: number): number {
	return Number(ticks) * tickNanoseconds / 1e9;
}

/**
 * CPU as a percentage of one core between two samples.
 *
 * Above 100 is normal and informative: `n_jobs=4` measured 310%.
 */
export function cpuPercent(previous: { at: number; cpuSeconds: number }, next: { at: number; cpuSeconds: number }): number | undefined {
	const seconds = (next.at - previous.at) / 1000;
	if (seconds <= 0) return undefined;
	return 100 * (next.cpuSeconds - previous.cpuSeconds) / seconds;
}

let cached: Libproc | null | undefined;

/** Loaded once. A machine without libproc samples nothing rather than throwing. */
export function libproc(): Libproc | null {
	if (cached === undefined) cached = open();
	return cached;
}

export function sampleAvailable(): boolean {
	return process.platform === "linux" ? linuxProcesses().length > 0 : libproc() !== null;
}

/**
 * One reading over every live process in the group.
 *
 * The whole group, because `n_jobs > 1` means joblib worker processes and the
 * parent's own CPU says nothing about what they are doing. Returns null once
 * the group is empty, which is how the caller learns the fit is over.
 */
export function sampleGroup(pgid: number, previous?: ResourceSample): ResourceSample | null {
	if (process.platform === "linux") return sampleLinuxGroup(pgid, previous);
	const library = libproc();
	if (!library) return null;
	const readings = library.groupPids(pgid).map((pid) => library.taskInfo(pid)).filter((entry) => entry !== null);
	if (readings.length === 0) return null;
	const sample: ResourceSample = {
		at: Date.now(),
		processes: readings.length,
		cpuSeconds: readings.reduce((total, entry) => total + entry!.cpuSeconds, 0),
		rssBytes: readings.reduce((total, entry) => total + entry!.rssBytes, 0),
	};
	const percent = previous ? cpuPercent(previous, sample) : undefined;
	if (percent !== undefined) sample.cpuPercent = percent;
	return sample;
}

/** Whether any process in the group is still alive. */
export function groupAlive(pgid: number): boolean {
	const library = libproc();
	if (!library) {
		try {
			process.kill(-pgid, 0);
			return true;
		} catch {
			return false;
		}
	}
	return library.groupPids(pgid).length > 0;
}


export interface LinuxProcess {
 pid: number; ppid: number; pgid: number; rssBytes: number; cpuSeconds: number;
 readBytes: number; writeBytes: number;
}
// sysconf values are read once, without spawning a command on each sample.
const linuxSystem = process.platform === "linux" ? dlopen("libc.so.6", {
 sysconf: { args: [FFIType.i32], returns: FFIType.i64 },
}) : undefined;
const clockTicks = linuxSystem ? Number(linuxSystem.symbols.sysconf(2)) : 100;
const pageBytes = linuxSystem ? Number(linuxSystem.symbols.sysconf(30)) : 4096;
export function linuxProcesses(root = "/proc"): LinuxProcess[] {
 const result: LinuxProcess[] = [];
 for (const name of readdirSync(root)) {
  if (!/^\d+$/.test(name)) continue;
  try {
   const stat = readFileSync(`${root}/${name}/stat`, "utf8");
   const f = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
   if (["Z", "X"].includes(f[0])) continue;
   let io = "";
   try { io = readFileSync(`${root}/${name}/io`, "utf8"); } catch { /* own-user /proc may restrict I/O */ }
   const counter = (key: string) => Number(io.match(new RegExp(`^${key}: (\\d+)`, "m"))?.[1] ?? 0);
   result.push({ pid: Number(name), ppid: Number(f[1]), pgid: Number(f[2]),
    cpuSeconds: (Number(f[11]) + Number(f[12])) / clockTicks,
    rssBytes: Number(f[21]) * pageBytes, readBytes: counter("read_bytes"), writeBytes: counter("write_bytes") });
  } catch { /* Processes can exit between directory enumeration and reading. */ }
 }
 return result;
}
export function sampleLinuxGroup(pgid: number, previous?: ResourceSample, root = "/proc"): ResourceSample | null {
 const all = linuxProcesses(root);
 const pids = new Set(all.filter(p => p.pgid === pgid).map(p => p.pid));
 // Include descendants which made a new process group while their parent lives.
 let changed = true;
 while (changed) {
  changed = false;
  for (const p of all) if (pids.has(p.ppid) && !pids.has(p.pid)) { pids.add(p.pid); changed = true; }
 }
 const members = all.filter(p => pids.has(p.pid));
 if (!members.length) return null;
 const sample: ResourceSample = { at: Date.now(), processes: members.length, pids: [...pids],
  largestProcessBytes: Math.max(...members.map(p => p.rssBytes)),
  rssBytes: members.reduce((n, p) => n + p.rssBytes, 0), cpuSeconds: members.reduce((n, p) => n + p.cpuSeconds, 0),
  readBytes: members.reduce((n, p) => n + p.readBytes, 0), writeBytes: members.reduce((n, p) => n + p.writeBytes, 0) };
 if (previous) sample.cpuPercent = Math.max(0, cpuPercent(previous, sample) ?? 0);
 return sample;
}
export interface MachineSample { availableBytes: number; totalBytes: number; swapTotalBytes: number; swapFreeBytes: number }
export function sampleMachine(path = "/proc/meminfo"): MachineSample {
 if (process.platform !== "linux") return { availableBytes: freemem(), totalBytes: totalmem(), swapTotalBytes: 0, swapFreeBytes: 0 };
 const text = readFileSync(path, "utf8");
 const bytes = (key: string) => {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
  if (!match) throw new Error(`Missing memory counter ${key}`);
  return Number(match[1]) * 1024;
 };
 return { availableBytes: bytes("MemAvailable"), totalBytes: bytes("MemTotal"), swapTotalBytes: bytes("SwapTotal"), swapFreeBytes: bytes("SwapFree") };
}
