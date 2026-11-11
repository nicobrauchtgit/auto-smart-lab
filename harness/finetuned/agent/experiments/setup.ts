import { readFileSync } from "node:fs";
import { linuxSystem, sampleAvailable, sampleMachine } from "./sampler.js";
import { processIdentity } from "./ownership.js";

/**
 * Read-only: no large allocation, model request, or signal probe.
 * `procRoot` is a test seam; production reads `/proc`.
 */
export function checkSupervision(procRoot = "/proc"): void {
 if (process.platform === "linux" && !linuxSystem()) throw new Error("sysconf unavailable: no loadable libc");
 if (!sampleAvailable(procRoot) || !processIdentity(process.pid)) throw new Error("Process sampler unavailable");
 const memory = sampleMachine(`${procRoot}/meminfo`);
 if (!(memory.totalBytes > 0) || memory.availableBytes < 0) throw new Error("Memory sampler unavailable");
 if (process.platform === "linux") {
  // Own-user processes must be observable; never rely on the kernel's OOM ordering.
  readFileSync(`${procRoot}/${process.pid}/io`);
  readFileSync(`${procRoot}/${process.pid}/status`);
 }
}
