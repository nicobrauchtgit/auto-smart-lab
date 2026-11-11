/** One process-wide arbiter shared by trial and shell supervisors. */
import { HARNESS_CONFIG } from "../harness/config.js";
import { sampleMachine, type MachineSample } from "./sampler.js";

export interface ProtectedWork {
 rssBytes: number;
 peakBytes: number;
 /** Largest live member, rather than a sum that favours many small workers. */
 largestProcessBytes: number;
 refresh?(): void;
 stop(peakBytes: number): Promise<unknown>;
}
export class MachineProtection {
 private readonly work = new Set<ProtectedWork>();
 private swapFullAt?: number;
 private stopping = false;
 constructor(private readonly limits = HARNESS_CONFIG.supervision,
  private readonly sample: () => MachineSample = sampleMachine) {}
 register(work: ProtectedWork): () => void { this.work.add(work); return () => { this.work.delete(work); }; }
 async check(now = Date.now()): Promise<void> {
  if (this.stopping || !this.work.size) return;
  const memory = this.sample();
  const swapFull = memory.swapTotalBytes > 0 && memory.swapFreeBytes === 0;
  if (swapFull) this.swapFullAt ??= now;
  else this.swapFullAt = undefined;
  const risk = memory.availableBytes < this.limits.memoryReserveBytes
   || (this.swapFullAt !== undefined && now - this.swapFullAt >= this.limits.swapFullSeconds * 1000);
  if (!risk) return;
  for (const work of this.work) work.refresh?.();
  const victim = [...this.work].sort((a, b) => b.largestProcessBytes - a.largestProcessBytes)[0];
  if (!victim || victim.rssBytes <= 0) return;
  this.stopping = true;
  try { await victim.stop(victim.peakBytes); }
  finally { this.stopping = false; }
 }
}
export const machineProtection = new MachineProtection();
