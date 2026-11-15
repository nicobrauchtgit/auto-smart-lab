# Reviewed integration and worktree cleanup, 2026-11-12

The canonical branch `v2-clean-slate` integrates the two historical prompt-first
experiment commits (`6ca11d3`, `af03281`) through a real merge, starting from
`580680a459fd9847483a7225a7b9388dabb51bba`. The five other worktree heads were
already integrated. All six branch refs remain as backups.

The merge retains the newer free nonterminal `hand_over` checkpoint, immutable
baseline and same-session improvement transition, explicit `finalize: true`
terminal delivery, admission security fix, no-local-sweep rule and iterative
scout guidance with fresh invocation budgets. It adds early baseline priority
and smoke → measure → validate → repair and remeasure guidance. The experiment's
600-second deadline and terminal-only semantics remain historical, and its
failed outcome is unchanged. No minimal-arm implementation or prompts changed.

The lead/checkpoint revision had independent review and a recorded full suite
of 675 passed / 2 skipped before this integration. The historical review logs
are preserved below. Earlier paid runs failed their delivery/time gates; this
cleanup ran no new task trials, model probes, uploads or pushes. P7c, reader
reuse, live delivery and the integration gate remain open.

## Durable preservation

Archive root: `runs/archives/worktree-cleanup-20261112T113940Z/` (ignored).
Each worktree directory has its original HEAD, ignored/untracked status,
exact `changes.jsonl`, binary tracked diff, `evidence.tar.gz`, and a per-member
SHA256/size or symlink-target manifest. Every tar member was read back and
verified before worktree removal; both dirty journals were compared byte for
byte again immediately before removal.

- `t3-7a94b912` and `t3-ff2efaba`: exact dirty dependency journals and diffs.
- `t3-ccac3cd8`: scout-budget/dry-run records, findings journals, training
  measurements and frozen sources, validation scratch and solutions history.
- `t3-58044980`: experiment launch/controller/preflight/test records, solutions
  history and scratch; `ram/spam1/` contains the private task-state target,
  including measurements, confirmation, progress and findings.
- `t3-a3e7e840`: private review directory and full/fast/focused/typecheck logs,
  including `ram/full-final.log` and `ram/review-8c66442-v135Cb/`.
- `t3-791866e9`: clean already-integrated state and journal snapshot.

The experiment and Stream C also have independently verified self-contained
`solutions.bundle` files, including refs for all detached trial snapshot
commits (two and four respectively). Their raw evidence archives preserve
original absolute worktree pointers for provenance; restore a bundle to inspect
solution history independently, or repair those pointers in an extracted copy.
Credentials/`.env`, disposable dependency trees and disposable test temporary
files were excluded. External canonical unit/data links were not followed.
Existing canonical run, export, recovery and controller evidence was retained.

Own-user `/proc` cwd, executable, open descriptors and memory maps showed no
live use of the worktrees or private snapshots before cleanup. Canonical
symlinks were checked for dependency on the snapshots and none resolved there.
All six worktrees were removed with `git worktree remove`; force was used only
for the two byte-preserved journals and two untracked tool-link worktrees.
Only `/dev/shm/t3-58044980` and `/dev/shm/t3-a3e7e840` were then removed.
No global tmpfs changes, unrelated RAM deletion or Nix garbage collection.

## Validation

All checks use `./dev` and disk-backed temporary storage. Raw logs are at the
archive root. The initial fast suite encountered an existing test assumption
that canonical TaskData was absent. Its failed log is retained. The test now
captures existing TaskData and asserts that pipeline/standalone setup checks
leave it unchanged, preserving measured run evidence rather than requiring its
deletion. The focused pipeline regression passes 12 tests.

Final check results and capacity follow.

- Focused prompts, lead session/resources, scout budget/runner and experiment
  boundary checks: 158 passed, 2 skipped, 0 failed (`focused.log`).
- Pipeline regression: 12 passed, 0 failed (`pipeline-regression.log`).
- Initial fast suite: 547 passed, 2 skipped, 1 failed, the retained-TaskData
  assumption described above (`fast.log`).
- Final `./dev bun run test:fast`: 548 passed, 2 skipped, 0 failed across 72
  files, 121.23 seconds (`fast-final.log`).
- `./dev bun run typecheck`: passed, both before and after the routine test
  correction (`typecheck.log`, `typecheck-final.log`).
- Full `./dev bun test`, before the merge commit: 675 passed, 2 skipped,
  0 failed across 91 files, 956.03 seconds (`full.log`).
- `git diff --check` and staged diff checks: passed. The minimal arm and
  `experiment/` have no changes.

## Capacity and final disposition

All six extra worktrees and the two named private RAM snapshots are removed.
The canonical checkout is the only registered worktree. Both experiment commits
and all five other heads are retained in canonical history; branch refs remain.
The archive also records retained refs, aggregate artifact hashes and verified
solution bundles. A full canonical-tree scan found no symlinks to either removed
snapshot. No credentials or dependencies were archived.

Root disk available: 530,472,960 → 8,452,403,200 bytes (505.9 MiB → 7.87 GiB).
Private snapshots accounted for most of tmpfs use: `/dev/shm` used
4,689,858,560 → 4,472,832 bytes (4.37 GiB → 4.27 MiB).
Host available RAM: 9.23 → 13.98 GiB
(point-in-time readings, not a benchmark). The six duplicate worktree
environments were a substantial contributor to disk pressure; no unrelated
root-disk cleanup was performed. Exact `df -B1` and `free -b` readings are in
`capacity-before.txt` and `capacity-after.txt`.
