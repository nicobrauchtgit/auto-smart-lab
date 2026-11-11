import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureSolutionsRepository, git, addWorktree, resolveCommit } from "./git.js";
import { runTrialChecks } from "./trial_checks.js";
test("live fixes cannot make a defective measured snapshot pass executable checks", async () => {
 const root = mkdtempSync(join(tmpdir(), "frozen-check-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = False\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured defect"]);
  const source = resolveCommit(live, "HEAD")!;
  addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const check = join(live, "checks", "test_model.py");
  writeFileSync(check, "from solutions.model import value\nassert value\n");
  writeFileSync(join(live, "model.py"), "value = True\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "live fix"]);
  // The process adapter is deliberately unsandboxed in this unit test; production supplies bubblewrap.
  const result = await runTrialChecks({ experimentId: "measured", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen) }, [check], { executable: "env", cwd: live, mounts: [{ source: dirname(frozen) }], env: { ...process.env } as Record<string, string>, args: command => command });
  expect(result.passed).toBe(false);
  expect(result.checks[0].exitCode).toBe(1);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
