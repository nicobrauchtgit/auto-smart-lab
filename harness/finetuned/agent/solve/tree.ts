/** Shared-tree rounds record committed edits as well as uncommitted leftovers. */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkpoint, recoverFollowUp } from "../training/branches.js";
import { ensureSolutionsRepository, git, uncommittedFiles } from "../training/git.js";
export interface TreeState { commit: string; uncommittedFiles: string[]; moved: { from: string; to: string }[]; changedPaths: string[] }
function marker(root: string) { return join(git(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim(), "code-work.json"); }
export async function beginCodeWork(root: string, label: string): Promise<TreeState> {
 ensureSolutionsRepository(root);
 const recovered = recoverFollowUp(root);
 if (recovered.error) throw new Error(recovered.error);
 if (existsSync(marker(root))) await endCodeWork(root, JSON.parse(readFileSync(marker(root), "utf8")).label);
 const saved = checkpoint(root, `Checkpoint before ${label}`);
 const commit = git(root, ["rev-parse", "HEAD"]).stdout.trim();
 writeFileSync(marker(root), JSON.stringify({ label, commit }));
 const dirty = uncommittedFiles(root);
 if (dirty.length) throw new Error("Code work cannot begin on a dirty tree");
 return { commit, uncommittedFiles: dirty, moved: saved.moved, changedPaths: [] };
}
export async function endCodeWork(root: string, label: string): Promise<TreeState> {
 const path = marker(root);
 if (!existsSync(path)) throw new Error("Missing code-work round");
 const start = JSON.parse(readFileSync(path, "utf8"));
 if (start.label !== label) throw new Error("Code-work label mismatch");
 const saved = checkpoint(root, `Checkpoint after ${label}`);
 const commit = git(root, ["rev-parse", "HEAD"]).stdout.trim();
 const changes = git(root, ["diff", "--name-only", "-z", start.commit, commit]);
 if (changes.status) throw new Error("Cannot resolve changed paths");
 const dirty = uncommittedFiles(root);
 if (dirty.length) throw new Error("Code work ended with uncommitted files");
 rmSync(path);
 return { commit, uncommittedFiles: dirty, moved: saved.moved, changedPaths: changes.stdout.split("\0").filter(Boolean) };
}
