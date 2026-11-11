import { readFileSync } from "node:fs";
import { sampleAvailable, sampleMachine } from "./sampler.js";
import { processIdentity } from "./ownership.js";

/** Read-only: no large allocation, model request, or signal probe. */
export function checkSupervision(): void {
 if (!sampleAvailable() || !processIdentity(process.pid)) throw new Error("Process sampler unavailable");
 const memory = sampleMachine();
 if (!(memory.totalBytes > 0) || memory.availableBytes < 0) throw new Error("Memory sampler unavailable");
 if (process.platform === "linux") {
  // Own-user processes must be observable; never rely on the kernel's OOM ordering.
  readFileSync(`/proc/${process.pid}/io`);
  readFileSync(`/proc/${process.pid}/status`);
 }
}
