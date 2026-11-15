import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCodeWork, endCodeWork } from "./tree.js";
import { git } from "../training/git.js";
test("rounds record agent-committed paths and move large leftovers to scratch", async () => {
 const root = mkdtempSync(join(tmpdir(), "code-work-"));
 try {
  await beginCodeWork(root, "first");
  writeFileSync(join(root, "committed.py"), "# authored\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "agent commit"]);
  writeFileSync(join(root, "large.bin"), Buffer.alloc(1024 * 1024 + 1));
  const ended = await endCodeWork(root, "first");
  expect(ended.changedPaths).toContain("committed.py");
  expect(ended.uncommittedFiles).toEqual([]);
  expect(ended.moved[0].from).toBe("large.bin");
  expect(existsSync(ended.moved[0].to)).toBe(true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
