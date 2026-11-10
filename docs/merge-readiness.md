# Merge scope and validation evidence

Updated 2026-11-10. Candidate branch: `merge-arms`. Target: `main`.
The branch has not been pushed or merged into `main` by this work.
Final whole-branch verification is running; readiness is not yet signed off.

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
| Documentation navigation, anchors and Mermaid structure | Integrated audit: 19 maintained documents, 281 local links/anchors, six Mermaid blocks, zero errors; structural coverage only |
| `git diff --check` | Passed at integration; repeat before sign-off |
| Final `./dev mise run test` | Running after the bounded recovery-test timeout correction |

The first whole-branch run completed its Bun suite with 651 passes, four skips,
one timeout failure and one resulting error across 656 tests. The recovery test
`restored original experiment budget cannot be increased by restart options`
used Bun's default five-second limit despite real Python setup/recovery checks.
Its diagnostic rerun took 5.3 seconds and passed with a test-local 30-second
limit. The assertion that restart cannot increase the original trial budget is
unchanged. The final complete suite is rerunning with that bounded test limit;
the first run must not be described as passing.

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
