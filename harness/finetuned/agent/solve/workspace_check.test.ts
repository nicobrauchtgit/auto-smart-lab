import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspace } from "./workspace_check.js";
test("static pass never imports authored code and reports missing index and docstrings", async () => {
 const root = mkdtempSync(join(tmpdir(), "workspace-check-"));
 try {
  mkdirSync(join(root, "tasks"));
  writeFileSync(join(root, "tasks", "x.py"), 'raise RuntimeError("must not execute")\n');
  const failed = await checkWorkspace(root, "x", ["tasks/x.py"]);
  expect(failed.valid).toBe(false);
  expect(failed.errors.length).toBe(2);
  writeFileSync(join(root, "INDEX.md"), '`tasks/x.py` owner lead; task x\n');
  writeFileSync(join(root, "tasks", "x.py"), '"""Purpose.\nInput and output.\n"""\nraise RuntimeError("must not execute")\n');
  expect((await checkWorkspace(root, "x")).valid).toBe(true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
