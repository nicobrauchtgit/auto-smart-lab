import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frameworkHash } from "./service.js";

test("terminal framework identity changes when imported PCAP adapter changes", () => {
 const root = mkdtempSync(join(tmpdir(), "refit-framework-"));
 try {
  for (const path of ["refit/worker.py", "training/python/runner.py", "refit/evidence.py", "training/python/task_samples.py", "training/python/pcap_samples.py"]) {
   mkdirSync(dirname(join(root, path)), { recursive: true });
   writeFileSync(join(root, path), `# immutable fixture ${path}\n`);
  }
  const frozen = frameworkHash(root);
  writeFileSync(join(root, "training/python/pcap_samples.py"), "# changed connection identity semantics\n");
  expect(frameworkHash(root)).not.toBe(frozen);
  rmSync(join(root, "training/python/pcap_samples.py"));
  expect(() => frameworkHash(root)).toThrow();
 } finally { rmSync(root, { recursive: true, force: true }); }
});
