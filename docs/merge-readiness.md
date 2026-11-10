# Merge scope and validation evidence

Updated 2026-11-10. **Proposed in `review/two-arm-experiment`, awaiting PR merge
into `main`, with P1 explicitly deferred.** The earlier direct merge was reverted
without rewriting published history. This branch restores the reviewed source;
only documentation status changed from the previously validated integration.
Final local whole-branch verification passed. This is code/documentation
readiness, not a claim of successful live experimental runs.

## Included and excluded

Both experiment arms, the shared switch and isolation contracts are included.
P3 run mechanics and its three final review fixes are integrated in `fd96ccd`;
P4 scorecard and P5 expert-team design are integrated in `d57b703` and `6901a54`.
The reviewer documentation adds current/proposed pipeline diagrams, source
metrics, code analysis and six ADRs.

The user explicitly deferred P1. Neither its memory-pool/observed-script
implementation nor its unconditional production guard is included. Its strict
acceptance requirement remains future work; see the
[investigation and scope decision](p1-memory-pool-blocker.md). Four-expert
execution, label-free final hand-over and the later redesign waves are not
implemented by merging design documents.

## Independent reviews

The P3 review of `ad016a5` found three recovery/accounting problems. Integration
`fd96ccd` fixes them with regressions: frozen champions remain available for
hand-over reconciliation while excluded from development; launch intent alone
does not consume a run trial; recovered budget-end refits retain caller-only
cancellation across the deadline. A later independent review of the integrated
fixes found no remaining issue and reproduced five focused scenarios.

The final Sol 6.1 review covered documentation `a67c8cf` and runtime `439ca9d`,
including `fd96ccd` and `95b90fc`. It found no new blockers in the reduced scope.
Its one wording correction is applied: the first champion is initialized from
eligible open trials; paired improvement is required to replace an existing
champion. Source metrics and package statuses were refreshed on integration.
Small refresh corrections were applied locally; full final tests are recorded
below separately from review findings.

## Validation

Run all commands from the repository root through `./dev`.

| Check | Result |
| --- | --- |
| P3 focused orchestrator, training-results and detached CLI tests | 61 passed, zero failures |
| Independent final runtime review scenarios | 5 passed, 21 assertions |
| Python environment manager `setup` | Healthy: 39 packages, Python 3.13.15; repaired stale editable-package worktree reference without changing declared dependencies |
| Inventory generation, `--check`, `--self-test` | Passed against integrated source; source and generator hashes in [inventory](code-inventory.md) |
| Strict standalone inventory-generator typecheck | Passed; `scripts/**/*.ts` is also included in the root typecheck |
| Documentation navigation, anchors and Mermaid structure | Integrated audit: 19 maintained documents, 284 local links/anchors, six Mermaid blocks, zero errors; structural coverage only |
| Change-only `git diff --check` | Passed for preparation/status edits. The full merge-relative audit also reports inherited whitespace in older training files and archived VM code/patches; tracked as F8 rather than rewriting historical material |
| Target merge preview | Local `main` and `origin/main` merge without conflicts and produce the candidate tree; read-only remote lookup confirmed `main` at `98c5f14b9297c5eb19f9e90c9196704c10b52787` on 2026-11-10 |
| Final `./dev mise run test` | Passed: root typecheck, 652 Bun tests passed / 4 skipped / 0 failed, then 155 Python tests passed |

The first whole-branch run completed its Bun suite with 651 passes, four skips,
one timeout failure and one resulting error across 656 tests. The recovery test
`restored original experiment budget cannot be increased by restart options`
used Bun's default five-second limit despite real Python setup/recovery checks.
Its diagnostic rerun took 5.3 seconds and passed with a test-local 30-second
limit. The assertion that restart cannot increase the original trial budget is
unchanged. The final complete suite passed with that bounded test limit: 656
Bun cases across 84 files in 778.77 seconds (652 passed, four skipped), followed
by 18 setup, 123 training, nine evaluation and five research Python tests, all
passing. The four skips are Darwin/libproc sampling and watcher cases on Linux.
The first run remains failed evidence; it is superseded by this successful
rerun rather than relabelled as passing.

The rerun used the integrated runtime/test source committed in `c4fcfe3`.
Subsequent sign-off edits are documentation only and do not change the source
inventory digest. Typecheck also passed after adding the inventory script to
the root TypeScript configuration. The final Python environment check reports
healthy declared and locked dependencies.

The earlier documentation checkout separately passed 155 Python tests and
68 focused tests with four platform skips. Those are historical supporting
checks, not substitutes for the integrated whole-branch run.

Inventory validation commands:

```bash
./dev bun scripts/code-inventory.ts
./dev bun scripts/code-inventory.ts --check
./dev bun scripts/code-inventory.ts --self-test
./dev bun run typecheck
```

No live model pipeline, real upload or new official score was produced by merge
preparation. Local worker/refit/recovery fixtures exercise code paths; they do
not establish a successful live integrated shakedown.

## Remaining limits

The [active queue](cleanup-plan.md#follow-ups-and-readiness-limits) owns follow-ups
F1–F9 and their completion evidence. These include the live spam shakedown,
measured protocol, incomplete task preparation, non-binary confirmation,
label-free hand-over, instructional sealed-guidance boundary, code concentration
and deferred resource supervision. Known minimal-parent `/proc` credential
exposure and filesystem-versus-network limits are recorded in the
[experiment contract](experiment.md#the-arms-must-not-interfere).

The six Mermaid diagrams were structurally reviewed; no renderer was installed,
so rendered layout is not verified. Source counts describe syntax and file
concentration; they do not measure quality, semantic feature count or correctness.
The source digest is independent of documentation commit IDs, so committing
the report does not invalidate it.
