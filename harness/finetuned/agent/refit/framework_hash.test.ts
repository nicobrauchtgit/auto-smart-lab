import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frameworkHash, REFIT_FRAMEWORK_FILES } from "./service.js";

test("terminal framework identity covers PCAP and confirmation verification dependencies", () => {
 const root = mkdtempSync(join(tmpdir(), "refit-framework-"));
 try {
  for (const path of REFIT_FRAMEWORK_FILES) {
   mkdirSync(dirname(join(root, path)), { recursive: true });
   writeFileSync(join(root, path), `# immutable fixture ${path}\n`);
  }
  const frozen = frameworkHash(root);
  for (const path of ["training/python/pcap_samples.py", "training/python/confirm.py", "confirmation/receipt.ts", "training/python/smartlab_trial/metrics.py"]) {
   writeFileSync(join(root, path), "# changed verification semantics\n");
   expect(frameworkHash(root)).not.toBe(frozen);
   writeFileSync(join(root, path), `# immutable fixture ${path}\n`);
   expect(frameworkHash(root)).toBe(frozen);
  }
  rmSync(join(root, "training/python/pcap_samples.py"));
  expect(() => frameworkHash(root)).toThrow();
 } finally { rmSync(root, { recursive: true, force: true }); }
});
