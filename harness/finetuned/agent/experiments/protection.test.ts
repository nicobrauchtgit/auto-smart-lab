import { expect, test } from "bun:test";
import { MachineProtection, type ProtectedWork } from "./protection.js";
import { HARNESS_CONFIG } from "../harness/config.js";

test("machine protection picks the largest member across owners and serializes stops", async () => {
 const stopped: string[] = [];
 const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => ({ availableBytes: 0, totalBytes: 16e9, swapFreeBytes: 0, swapTotalBytes: 0 }));
 const work = (name: string, largest: number, total: number): ProtectedWork => ({ rssBytes: total, largestProcessBytes: largest, peakBytes: total,
  async stop(peak) { expect(peak).toBe(total); stopped.push(name); await Bun.sleep(5); } });
 const remove = guard.register(work("large", 8e9, 8e9));
 guard.register(work("many-small", 2e9, 10e9));
 await Promise.all([guard.check(), guard.check()]);
 expect(stopped).toEqual(["large"]);
 remove();
 await guard.check();
 expect(stopped).toEqual(["large", "many-small"]);
});

test("swap must remain (nearly) full for fifteen seconds; no swap is not full swap", async () => {
 let total = 1e9, free = 0, stops = 0;
 const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => ({ availableBytes: 4e9, totalBytes: 16e9, swapFreeBytes: free, swapTotalBytes: total }));
 guard.register({ rssBytes: 1, largestProcessBytes: 1, peakBytes: 2, async stop() { stops++; } });
 await guard.check(0); await guard.check(14999); expect(stops).toBe(0);
 free = 500e6; await guard.check(15000); free = 0;
 await guard.check(16000); await guard.check(30999); expect(stops).toBe(0);
 await guard.check(31000); expect(stops).toBe(1);
 total = 0; await guard.check(100000); expect(stops).toBe(1);
});
