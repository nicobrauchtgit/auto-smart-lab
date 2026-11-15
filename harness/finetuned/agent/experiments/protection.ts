/** One process-wide arbiter shared by trial and shell supervisors. */
import { HARNESS_CONFIG } from "../harness/config.js";
import { sampleMachine, type MachineSample } from "./sampler.js";

export interface ProtectedWork {
 rssBytes: number;
 peakBytes: number;
 /** Largest live member, rather than a sum that favours many small workers. */
 largestProcessBytes: number;
 refresh?(): void;
 /** `machine` is the reading the stop decision acted on, so the owner's warning uses it too. */
 stop(peakBytes: number, machine: MachineSample): Promise<unknown>;
}

/**
 * The kernel keeps a few slots and pages back, so a swap device under pressure
 * rarely reports exactly zero free. Below 1% of its size, at most 64 MiB, it is
 * as full as it gets.
 */
export function swapFull(memory: MachineSample): boolean {
 if (memory.swapTotalBytes <= 0) return false;
 return memory.swapFreeBytes < Math.min(memory.swapTotalBytes * 0.01, 64 * 1024 ** 2);
}

export class MachineProtection {
 private readonly work = new Set<ProtectedWork>();
 /**
  * Work this arbiter already stopped. A stop that could not end every process
  * leaves the work registered with its memory; choosing it again would only
  * repeat the same message, so the next largest process is chosen instead.
  */
 private readonly stopped = new WeakSet<ProtectedWork>();
 private swapFullAt?: number;
 private stopping = false;
 constructor(private readonly limits = HARNESS_CONFIG.supervision,
  private readonly sample: () => MachineSample = sampleMachine) {}
 /** Available RAM below this stops the largest process. Warnings are measured against it. */
 get reserveBytes(): number { return this.limits.memoryReserveBytes; }
 /** One reading. A supervisor's tick passes it on to `check`, so a warning and a stop never disagree. */
 machine(): MachineSample { return this.sample(); }
 register(work: ProtectedWork): () => void { this.work.add(work); return () => { this.work.delete(work); }; }
 async check(now = Date.now(), memory?: MachineSample): Promise<void> {
  if (this.stopping || !this.work.size) return;
  memory ??= this.sample();
  if (swapFull(memory)) this.swapFullAt ??= now;
  else this.swapFullAt = undefined;
  const risk = memory.availableBytes < this.limits.memoryReserveBytes
   || (this.swapFullAt !== undefined && now - this.swapFullAt >= this.limits.swapFullSeconds * 1000);
  if (!risk) return;
  for (const work of this.work) work.refresh?.();
  const victim = [...this.work].filter(work => !this.stopped.has(work) && work.rssBytes > 0)
   .sort((a, b) => b.largestProcessBytes - a.largestProcessBytes)[0];
  if (!victim) return;
  this.stopped.add(victim);
  this.stopping = true;
  try { await victim.stop(victim.peakBytes, memory); }
  finally { this.stopping = false; }
 }
}
export const machineProtection = new MachineProtection();
