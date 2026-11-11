/** Reconstruct immutable source from the authoritative trial receipt. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep, dirname, basename } from "node:path";
import { addWorktree, git, resolveCommit, uncommittedFiles } from "./git.js";
import type { TrialSnapshot } from "../team/contracts.js";
export async function resolveTrialSnapshot(root: string, experimentId: string): Promise<TrialSnapshot> {
 if (!/^[A-Za-z0-9_-]{1,64}$/.test(experimentId)) throw new Error("Unsafe experiment ID");
 const receipt = JSON.parse(readFileSync(join(root, experimentId, "recovery.json"), "utf8"));
 const trial = receipt.trial;
 if (trial?.id !== experimentId || !trial.source?.commit || !trial.source.tree) throw new Error("Missing trial source identity");
 const worktree = resolve(trial.worktrees?.[0] ?? "");
 if (!worktree.startsWith(`${resolve(root, experimentId)}${sep}`) || basename(worktree) !== "solutions") throw new Error("Unsafe trial source root");
 const sourceRoot = dirname(worktree);
 const live = receipt.solutionsRoot;
 if (!existsSync(worktree)) {
  if (!live) throw new Error("Missing trial snapshot and repository identity; cannot restore source");
  git(live, ["worktree", "prune"]);
  addWorktree(live, worktree, trial.source.commit);
 }
 const actual = resolveCommit(worktree, "HEAD");
 if (!actual || actual.commit !== trial.source.commit || actual.tree !== trial.source.tree || uncommittedFiles(worktree).length) throw new Error("Trial snapshot identity mismatch");
 return { experimentId, commit: actual.commit, tree: actual.tree, sourceRoot };
}
