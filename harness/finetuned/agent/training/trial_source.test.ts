import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSolutionsRepository, git, resolveCommit, addWorktree, removeWorktree } from "./git.js";
import { resolveTrialSnapshot } from "./trial_source.js";
test("snapshot resolution restores the measured commit after cleanup and rejects dirty source", async () => {
 const root = mkdtempSync(join(tmpdir(), "trial-source-"));
 const live = join(root, "solutions"), trials = join(root, "trials"), source = join(trials, "trial1", "source", "solutions");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "raise RuntimeError('frozen defect')\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured"]);
  const measured = resolveCommit(live, "HEAD")!;
  mkdirSync(join(trials, "trial1"), { recursive: true });
  writeFileSync(join(trials, "trial1", "recovery.json"), JSON.stringify({ solutionsRoot: live, trial: { id: "trial1", source: measured, worktrees: [source] } }));
  addWorktree(live, source, measured.commit); removeWorktree(live, source);
  writeFileSync(join(live, "model.py"), "# live passes\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "later fix"]);
  expect((await resolveTrialSnapshot(trials, "trial1")).commit).toBe(measured.commit);
  writeFileSync(join(source, "model.py"), "# altered snapshot\n");
  await expect(resolveTrialSnapshot(trials, "trial1")).rejects.toThrow("identity mismatch");
 } finally { rmSync(root, { recursive: true, force: true }); }
});
