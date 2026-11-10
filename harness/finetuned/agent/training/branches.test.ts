import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSolutionsRepository, git, uncommittedFiles } from "./git.js";
import { finishFollowUp, followUpBranches, recoverFollowUp, startFollowUp } from "./branches.js";

function repository() {
 const root = mkdtempSync(join(tmpdir(), "branches-"));
 ensureSolutionsRepository(root);
 const commit = (file: string, message: string) => { writeFileSync(join(root, file), message); git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", message]); return git(root, ["rev-parse", "HEAD"]).stdout.trim(); };
 const head = () => git(root, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
 return { root, commit, head };
}

test("a first round gets no branch; with a champion the round starts on a branch from it and switches back", () => {
 const { root, commit, head } = repository();
 try {
  expect(startFollowUp(root, "spam1", "first")).toBeUndefined();
  const champion = commit("a.py", "champion pipeline");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  commit("b.py", "later work on main");
  const start = startFollowUp(root, "spam1", "abc123")!;
  expect(start).toMatchObject({ branch: "followup/spam1/abc123", champion, previous: "main", detached: false });
  expect(git(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(champion);
  const tip = commit("c.py", "follow-up idea");
  expect(followUpBranches(root, "spam1").checkedOut).toBe("followup/spam1/abc123");
  expect(finishFollowUp(root, start)).toEqual({ restored: true });
  expect(head()).toBe("main");
  const listed = followUpBranches(root, "spam1");
  expect(listed).toMatchObject({ champion: champion.slice(0, 12), checkedOut: "main", omitted: 0 });
  expect(listed.branches).toEqual([{ name: "followup/spam1/abc123", head: tip.slice(0, 12), subject: "follow-up idea", headIsChampion: false, containsChampion: true }]);
  // Another task's champion never creates a branch for this one.
  expect(followUpBranches(root, "spam2").branches).toEqual([]);
  expect(() => startFollowUp(root, "spam1", "bad/label")).toThrow("Invalid follow-up label");
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uncommitted work is committed on its own branch, never carried across a switch", () => {
 const { root, commit, head } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  writeFileSync(join(root, "draft_main.py"), "left on main");
  const start = startFollowUp(root, "spam1", "r1")!;
  expect(uncommittedFiles(root)).toEqual([]);
  expect(git(root, ["log", "-1", "--format=%s", "main"]).stdout).toContain("saved by the harness before follow-up");
  writeFileSync(join(root, "draft_followup.py"), "left on the branch");
  expect(finishFollowUp(root, start)).toEqual({ restored: true, checkpoint: true });
  expect(head()).toBe("main");
  expect(git(root, ["ls-tree", "--name-only", "main"]).stdout).not.toContain("draft_followup.py");
  expect(git(root, ["ls-tree", "--name-only", "followup/spam1/r1"]).stdout).toContain("draft_followup.py");
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a round cut short by a crash is closed by the next solve, and the same invocation can reopen its branch", () => {
 const { root, commit, head } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  startFollowUp(root, "spam1", "crashed");
  // No finishFollowUp: the process died.
  expect(recoverFollowUp(root)).toMatchObject({ recovered: { branch: "followup/spam1/crashed", previous: "main" } });
  expect(head()).toBe("main");
  expect(recoverFollowUp(root)).toEqual({});
  const reopened = startFollowUp(root, "spam1", "crashed")!;
  expect(head()).toBe("followup/spam1/crashed");
  expect(reopened.previous).toBe("main");
  expect(finishFollowUp(root, reopened).restored).toBe(true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("long commit subjects are cut by bytes", () => {
 const { root, commit } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  const start = startFollowUp(root, "spam1", "long")!;
  commit("b.py", "ü".repeat(200));
  finishFollowUp(root, start);
  expect(Buffer.byteLength(followUpBranches(root, "spam1").branches[0]!.subject)).toBeLessThanOrEqual(124);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("outside a repository there are no branches", () => {
 const root = mkdtempSync(join(tmpdir(), "no-repo-"));
 try { expect(startFollowUp(root, "spam1", "x")).toBeUndefined(); expect(followUpBranches(root, "spam1")).toEqual({ champion: null, checkedOut: null, branches: [] }); expect(recoverFollowUp(root)).toEqual({}); }
 finally { rmSync(root, { recursive: true, force: true }); }
});

test("work left on a bare commit is parked on a branch before the round, so it stays reachable", () => {
 const { root, commit } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  git(root, ["switch", "--quiet", "--detach", champion]);
  writeFileSync(join(root, "draft.py"), "unsaved");
  const start = startFollowUp(root, "spam1", "r2")!;
  expect(start.previous).toBe("harness/checkpoint/r2");
  expect(finishFollowUp(root, start).restored).toBe(true);
  expect(git(root, ["ls-tree", "--name-only", "HEAD"]).stdout).toContain("draft.py");
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an open round that cannot be closed blocks new rounds instead of losing the start point", () => {
 const { root, commit } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  startFollowUp(root, "spam1", "stuck");
  const marker = join(git(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim(), "smartlab-follow-up.json");
  writeFileSync(marker, "not json");
  expect(recoverFollowUp(root).error).toContain("Unreadable follow-up record");
  expect(() => startFollowUp(root, "spam1", "next")).toThrow("still open");
  rmSync(marker);
  // Without a record, a follow-up branch is never taken as the place to return to.
  expect(() => startFollowUp(root, "spam1", "next")).toThrow("no record of where it started");
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large untracked files stay out of checkpoint commits", () => {
 const { root, commit } = repository();
 try {
  const champion = commit("a.py", "champion");
  git(root, ["tag", "-a", "champion/spam1", "-m", "{}", champion]);
  const start = startFollowUp(root, "spam1", "big")!;
  writeFileSync(join(root, "features.npy"), Buffer.alloc(2 * 1024 * 1024));
  writeFileSync(join(root, "idea.py"), "small");
  const finished = finishFollowUp(root, start);
  expect(finished).toMatchObject({ restored: true, checkpoint: true, skipped: ["features.npy"] });
  expect(git(root, ["ls-tree", "--name-only", "followup/spam1/big"]).stdout).not.toContain("features.npy");
 } finally { rmSync(root, { recursive: true, force: true }); }
});
