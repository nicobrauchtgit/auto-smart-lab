/**
 * Follow-up rounds work on their own branch in solutions/. When a task already
 * has a champion, a new solve invocation starts on `followup/<task>/<label>`,
 * created from the champion commit, and the harness switches back to the
 * previous branch afterwards. The branch and its commits stay for comparison;
 * the champion tag alone decides what is best.
 *
 * Uncommitted work is never carried across a switch: the harness commits it on
 * the branch it was made on first. A marker in the repository's git directory
 * records an open round, so a round cut short by a crash is closed by the next
 * solve before it starts.
 */
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { git, HARNESS_IDENTITY, isRepositoryRoot, uncommittedFiles } from "./git.js";
import { championTag } from "./development_selection.js";

export interface FollowUpStart { branch: string; champion: string; previous: string; detached: boolean; taskId?: string }

const MAX_LISTED = 8;
/** Untracked files above this size are left in place, never committed by the harness. */
const MAX_CHECKPOINT_FILE_BYTES = 1024 * 1024;
const MAX_SUBJECT_BYTES = 120;
export const followUpPrefix = (taskId: string) => `followup/${championTag(taskId).slice("champion/".length)}/`;

function championCommit(root: string, taskId: string): string | undefined {
 const result = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${championTag(taskId)}^{commit}`]);
 return result.status === 0 ? result.stdout.trim() : undefined;
}

function markerPath(root: string): string {
 const dir = git(root, ["rev-parse", "--git-dir"]).stdout.trim();
 return join(isAbsolute(dir) ? dir : join(root, dir), "smartlab-follow-up.json");
}

function failure(result: { stderr: string }) { return result.stderr.trim().split("\n").slice(-2).join(" "); }

/**
 * Commit leftover work where it was made, so a switch never moves it to another
 * branch. Tracked changes and small untracked files are committed; large untracked
 * files (data, caches) stay in the working tree and out of the permanent history.
 */
export function checkpoint(root: string, reason: string): { committed: boolean; skipped: string[] } {
 if (uncommittedFiles(root).length === 0) return { committed: false, skipped: [] };
 const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
 const small = untracked.filter(path => { try { return statSync(join(root, path)).size <= MAX_CHECKPOINT_FILE_BYTES; } catch { return false; } });
 const skipped = untracked.filter(path => !small.includes(path));
 for (const path of skipped) {
  const destination = join(root, "scratch", "checkpoint", `${Date.now()}-${crypto.randomUUID()}`, path);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(join(root, path), destination);
 }

 for (const step of [["add", "-u"], ...(small.length ? [["add", "--", ...small]] : [])]) {
  const added = git(root, step);
  if (added.status !== 0) throw new Error(`Could not save uncommitted work before switching branches: ${failure(added)}`);
 }
 if (git(root, ["diff", "--cached", "--quiet"]).status === 0) return { committed: false, skipped };
 const committed = git(root, [...HARNESS_IDENTITY, "commit", "--quiet", "--no-verify", "-m", reason]);
 if (committed.status !== 0) throw new Error(`Could not save uncommitted work before switching branches: ${failure(committed)}`);
 return { committed: true, skipped };
}

function currentBranch(root: string): { previous: string; detached: boolean; taskId?: string } {
 const current = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
 return current.status === 0 ? { previous: current.stdout.trim(), detached: false } : { previous: git(root, ["rev-parse", "HEAD"]).stdout.trim(), detached: true };
}

/**
 * Close a round a crash left open: switch back to where it started. An error means
 * the repository is still in an open round; no new round may start from it.
 */
export function recoverFollowUp(root: string): { recovered?: FollowUpStart; error?: string } {
 if (!isRepositoryRoot(root)) return {};
 const path = markerPath(root);
 if (!existsSync(path)) return {};
 let open: FollowUpStart;
 try { open = JSON.parse(readFileSync(path, "utf8")) as FollowUpStart; if (!open?.branch || !open.previous) throw new Error("incomplete"); }
 catch { return { error: `Unreadable follow-up record ${path}; switch solutions/ back by hand and remove it` }; }
 const finished = finishFollowUp(root, open);
 return finished.restored ? { recovered: open } : { recovered: open, error: finished.error };
}

/** Create (or reopen) and check out the follow-up branch. Undefined when the task has no champion yet: a first round needs no branch. */
export function startFollowUp(root: string, taskId: string, label: string): FollowUpStart | undefined {
 if (!isRepositoryRoot(root)) return undefined;
 const champion = championCommit(root, taskId);
 if (!champion) return undefined;
 if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) throw new Error("Invalid follow-up label");
 const branch = `${followUpPrefix(taskId)}${label}`;
 if (existsSync(markerPath(root))) throw new Error("A follow-up round is still open in solutions/; it must be closed before another starts");
 // Leftover work on a bare commit gets a branch first, so its checkpoint stays reachable.
 if (currentBranch(root).detached && uncommittedFiles(root).length) {
  const parked = git(root, ["switch", "--quiet", "-c", `harness/checkpoint/${label}`]);
  if (parked.status !== 0) throw new Error(`Could not keep uncommitted work from a detached checkout: ${failure(parked)}`);
 }
 checkpoint(root, `Uncommitted work saved by the harness before follow-up ${branch}`);
 const { previous, detached } = currentBranch(root);
 // Without a record of where the agent was, a follow-up branch is no place to return to.
 if (previous.startsWith(followUpPrefix(taskId))) throw new Error(`solutions/ is on follow-up branch ${previous} with no record of where it started; switch it back first`);
 // The same invocation reconciling after a crash reopens its own branch instead of failing.
 const exists = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
 const switched = git(root, exists ? ["switch", "--quiet", branch] : ["switch", "--quiet", "-c", branch, champion]);
 if (switched.status !== 0) throw new Error(`Could not check out follow-up branch ${branch}: ${failure(switched)}`);
 const start = { branch, champion, previous, detached, taskId };
 writeFileSync(markerPath(root), JSON.stringify(start));
 return start;
}

/** Switch back to where the round started, after committing leftover work on the round's branch. */
export function finishFollowUp(root: string, start: FollowUpStart): { restored: boolean; checkpoint?: boolean; skipped?: string[]; error?: string } {
 let saved: ReturnType<typeof checkpoint>;
 try { saved = checkpoint(root, `Uncommitted work saved by the harness at the end of ${start.branch}`); }
 catch (error) { return { restored: false, error: error instanceof Error ? error.message : String(error) }; }
 const extra = { ...(saved.committed ? { checkpoint: true } : {}), ...(saved.skipped.length ? { skipped: saved.skipped.slice(0, 20) } : {}) };
 const result = git(root, start.detached ? ["switch", "--quiet", "--detach", start.previous] : ["switch", "--quiet", start.previous]);
 // The record stays until the switch back succeeds, so the next solve can retry it.
 if (result.status !== 0) return { restored: false, ...extra, error: failure(result) };
 const champion = start.taskId ? championCommit(root, start.taskId) : undefined;
 if (champion && champion !== start.champion && git(root, ["merge-base", "--is-ancestor", champion, start.branch]).status === 0) {
  const merged = git(root, [...HARNESS_IDENTITY, "merge", "--no-edit", start.branch]);
  if (merged.status !== 0) {
   git(root, ["merge", "--abort"]);
   return { restored: false, ...extra, error: `Follow-up merge conflict; round retained: ${failure(merged)}` };
  }
 }
 rmSync(markerPath(root), { force: true });
 return { restored: true, ...extra };
}

function boundedSubject(subject: string): string {
 const bytes = Buffer.from(subject);
 return bytes.length <= MAX_SUBJECT_BYTES ? subject : `${bytes.subarray(0, MAX_SUBJECT_BYTES).toString("utf8").replace(/�+$/, "")}…`;
}

/** The task's follow-up branches for the orchestrator's status, newest last, and what is checked out. */
export function followUpBranches(root: string, taskId: string) {
 if (!isRepositoryRoot(root)) return { champion: null, checkedOut: null, branches: [] };
 const champion = championCommit(root, taskId);
 const listed = git(root, ["for-each-ref", "--sort=committerdate", "--format=%(refname:short)%09%(objectname)%09%(subject)", `refs/heads/${followUpPrefix(taskId)}`]);
 const rows = listed.status === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
 const branches = rows.slice(-MAX_LISTED).map(row => {
  const [name, commit, subject] = row.split("\t");
  const containsChampion = !!champion && git(root, ["merge-base", "--is-ancestor", champion, commit!]).status === 0;
  return { name, head: commit!.slice(0, 12), subject: boundedSubject(subject ?? ""), headIsChampion: commit === champion, containsChampion };
 });
 const current = currentBranch(root);
 return { champion: champion?.slice(0, 12) ?? null, checkedOut: current.detached ? current.previous.slice(0, 12) : current.previous, branches, omitted: Math.max(0, rows.length - MAX_LISTED) };
}
