# Completion reliability: investigation and proposed repair

2026-11-13. Status: investigated and planned, **runtime changes not implemented**.
Base: `96930a8`. No new model sessions, task runs, task-data fits, dependency
changes or uploads were made for this investigation.

## Required behavior

An unsuccessful improvement must not discard an earlier validated candidate.
At budget end, the harness should deliver the current candidate if it passes,
otherwise the recorded baseline if it still passes the same integrity and
validation requirements. Only an actual validated artifact is success.

The present checkpoint records readiness evidence, not an output artifact or a
completed full-data fit. Calling it a preserved deliverable overstates what
exists. This repair makes that evidence usable for delivery; it cannot truthfully
promise that arbitrary Python will never fail during its first full-data refit.
Do not turn a real execution failure into a successful status with invalid output.

## Findings

### 1. The checkpoint preserves bookkeeping, not a usable delivery selection

`agent/run/lead_progress.ts` persists `baseline` and its validation receipt.
`lead_session.ts` records it on the first successful readiness check. But the
budget/idle/session-end path selects only `championOf(...)`, validates it, and
sets `validation_failed` if that fails. It never tries the saved baseline.

This is confirmed by a scripted reproduction retained under
`runs/launches/2026-11-13-completion-audit/`: approve baseline, promote a different
candidate, exhaust budget, reject new candidate. Result: baseline remains in
PROGRESS, two validations, **zero refits**, `validation_failed`. The probe uses
synthetic dependencies and no model or Python training. Its temporary collected
test file was removed; source and result remain in the audit folder.

The existing checkpoint regression checks persistence through cancellation and
restart, then cancels again. It does not check successful delivery after a newer
champion fails. Existing budget-end tests explicitly expect failure on a `fix`
and do not contain an older validated candidate. They pass while the missing
product behavior remains absent.

### 2. Three components independently equate selection with latest champion

A one-branch fallback in the lead would be incomplete:

- `lead_session.ts`'s production `verifiedCandidate` resolves the current champion;
  `validate(experimentId)` additionally requires its identity to match that tag.
- `refit/service.ts:inspectRefitCandidate` reads that tag again. Its
  `expectedExperimentId` is an assertion, not a selection input. `runRefit` checks
  the current tag a second time under the terminal-selection lock.
- `confirmation/receipt.ts:confirmedCandidate` reads only `latest.json` and rejects
  a different experiment/source/pipeline, even if that earlier candidate has a
  valid durable confirmation receipt and ledger reservation.

Retagging an old candidate or rewriting confirmation pointers to make fallback
work would conceal the distinction between statistical champion and delivery
selection. Weakening the mismatch assertions would introduce evidence substitution.
Neither is an acceptable fix.

### 3. Validation's promised evidence is not its mounted evidence

`prompts/team/validation.md` tells the scout that trial records are in the parent
directory. `run/sandbox.ts` mounts the frozen `source/` subtree, and
`team/runner.ts:scoutToolset` retains that mount while hiding live solutions.
The sibling request/invocation/result files are outside that source mount.
The reviewer cannot read them just by walking upward. This is an interface
contract defect, not a reason to expose the entire training directory.

The final spam2 reviewer could see defaults in source but not the authoritative
parameters. It blocked on inability to verify the configuration, although the
stored request and refit code retain and apply the exact measured parameters.
It also blocked on empty-channel tolerance absent from the measured commit,
reasoning about a smaller terminal fit; the actual terminal fit uses all original
labelled training rows. The source limitation exists, but that terminal failure
was not demonstrated. No spam2 terminal worker ran.

`validationSummary` parses bullet prefixes; `validationPassed` requires a completed
report, some labelled evidence, and no `fix`. It does not establish whether a
`fix` actually concerns the selected configuration or actual execution population.
The whole report status is not a substitute for that reasoning. Passing check
exit status is also not proof that every intended assertion was reached.

### 4. The same completion pattern recurred before this run

| Evidence / previous fix | What it established | Consequence for this repair |
| --- | --- | --- |
| Nov 11 old multi-stage spam run | Repeated hand-offs, inconsistent input contracts, recovered budget mistakes and extensive local fits produced hours of delay | Do not restore an orchestrator, another reviewer layer, or a continuation scheduler |
| Early Nov 12 v2 unit-one failure | Late validation found a reader swallowing I/O errors; live repair was never measured | Never refit live HEAD in place of the selected measured source; a genuine defect must remain blocking for that candidate |
| Ten-minute prompt experiment | Snapshot visibility trouble blocked validation; prompt priority alone did not deliver | Fix the evidence contract in code; another instruction to finish early is insufficient |
| Free checkpoint change (`1d3ff9b`, admission fix `8c66442`) | Baseline evidence persists; free calls cannot donate admission to mutations | Complete the missing delivery behavior without changing call admission or reopening mutation after terminal selection |
| Async scout changes (`93e004c`) | The lead need not block while researching; cleanup still owns background work | Reuse existing cancellation and drain; do not add background fallback services |
| Hash-executed-check fix (`7ea542b`) | Check references describe the bytes actually executed | Preserve immutable check capture; never infer validity from a newly edited check file |
| Symlink/path failure and fix (`c8aaa29`) | Measured source must already be refit eligible; module roots are shared across smoke/trials | Keep early admission checks and stored request formats; do not use symlinks or live code to repair a frozen candidate |
| Validation tool fix (`c746a7a`) | Seven live validation sessions had no bash; checks ran through `run_checks` | Keep the allowlist and snapshot runner; no shell restoration |
| Latest spam2 local three-candidate loop | Lead rationalized a scored comparison as branch smoke coverage despite the rule | Still an open behavior issue; do not claim the validation shell fix solved lead behavior or add a regex ban on all fitting |
| Completion controller's wrong `manifest.arm` assertion | A successful spam1 artifact was initially misclassified by new controller code | Verify actual artifacts through existing delivery contracts, not another bespoke success predicate |

The two recent primary reports are
[unit-one](experiments/v2-unit1-2026-11-12.md) and
[completion/tool choice](experiments/spam-completion-tool-choice-2026-11-13.md).
This investigation relies on repository code and measured run evidence; it makes
no general research claim about agents.

## Smallest coherent implementation

Keep one lead, the current statistical promotion rules, the existing baseline
record, existing validation receipts and the terminal refit service. Use a bounded
choice of **current champion, then recorded baseline**, deduplicated. Do not build
a ranked fallback history, a new registry, a second journal or an agent retry loop.

### A. Make the selected measured candidate explicit

Factor the existing candidate verification into one internal path that accepts
the controller's selected experiment and expected immutable source identity.
Derive parameters and fingerprints from authoritative records; do not accept an
agent-provided substitute pipeline dictionary. Reuse existing types where they
fit instead of copying a full `RefitFreeze` into PROGRESS.

Use this path for validation and terminal preparation. The lead chooses an older
candidate only through its already-recorded baseline/receipt, not by arbitrary
score sorting or a new public tool argument. Preserve standalone refit's default
behavior: without an explicit controller selection, the authoritative champion
tag still selects the candidate.

Bind confirmation to that selected candidate's exact durable receipt. Capture or
resolve its existing protected receipt reference and verify hash, task, dataset,
source, parameters and ledger reservation. `latest.json` remains a convenience
pointer, not proof that historical confirmation disappeared. Do not issue a new
Ladder query or reset the read ledger merely to recover the baseline. Missing,
failed or corrupt required confirmation still blocks it.

Under the existing selection lock, freeze the same approved identity the lead
selected. Compare against its protected evidence instead of requiring that it
still be the newest statistical champion. Keep worker drain and evidence hash
checks before freezing. Keep the existing terminal marker and recovery path.

Primary code: `run/lead_session.ts`, `refit/service.ts`,
`confirmation/receipt.ts`; adapt confirmation's existing selection plumbing only
where it currently reconstructs the same choice from the latest tag. Avoid
another candidate service or overlapping inspector.

### B. Replace the false records promise with a small truthful review input

Provide the scout one controller-owned, read-only summary for the selected
candidate. Build it from the verified request/invocation rather than the lead's
description. Include exact fixed parameters, module/factory, source identity,
development CV scheme/coverage and the actual fit/predict contract. State that
terminal fit uses all original labelled training rows, outside the agent boundary.

Exclude sealed IDs, labels, private scores, predictions, ledger contents,
credentials and arbitrary raw-record fields. Do not mount the training parent or
write summary metadata into the measured source tree. Prefer typed opening data
or an existing staged-input mechanism over a new directory hierarchy.

Remove the misleading parent-directory sentence. Ask the reviewer to assess the
selected request, not factory defaults, arbitrary optional branches or live edits.
Lack of access to unprovided evidence is an unavailable review, not a proven model
defect; possible small-sample failures are advice unless relevant and demonstrated
for the selected contract. Keep real leakage, wrong output and reproducible
contract defects blocking. Do not make every scout finding advisory or add another
LLM to arbitrate the first one. The fallback is still needed: better context alone
cannot guarantee a correct reviewer verdict.

### C. One finalization path, at most two selections

Share the selection/finalization routine between explicit terminal `hand_over`
and budget/idle/agent-failure end. Keep nonterminal checkpoint behavior unchanged.

1. Settle active trials through the existing lifecycle before choosing. Preserve
   the existing pending/error feedback and repair opportunity for an explicit
   hand-over request that cannot be accepted while the lead still has budget.
2. Inspect and validate the current champion using the truthful input above.
3. If it fails, inspect the recorded baseline. Verify its complete identity and
   receipt, including current data/environment/prompt/check-boundary requirements.
   If the receipt is stale, use the existing bounded validation path once; never
   treat stale approval as current proof. A demonstrated defect applying to the
   baseline must still reject it.
4. Accept the first eligible validated choice. At that acceptance boundary revoke
   later mutation admissions, close/cancel development work, then perform one
   terminal freeze, refit and delivery validation. Do not revoke admission merely
   because a hand-over was requested and rejected. Record chosen experiment and
   fallback reason in existing progress/events and delivery review metadata.
5. If neither qualifies, return specific per-candidate reasons. If cancellation
   or machine safety stopped the run, preserve that outcome rather than starting
   fallback work. After terminal freeze, use existing recovery for that same
   identity; do not try another model after sealed rows joined training.

This is a fallback in delivery selection, not an override for a failed candidate.
No fallback should use changed HEAD, a pilot, an interrupted search, a merely
higher raw score, or a candidate lacking confirmation. There is no fresh repair
session at budget end and no automatic budget top-up.

## Regressions required before another live run

Use the existing test fixtures and scripted sessions. Add behavior cases where
the gap exists; do not add tests that only mirror new helpers.

1. **The missing scenario:** baseline A passes; B promotes but fails validation;
   lead ends at the limit. Actual output is produced from A's frozen source and
   A's fixed parameters, while the statistical champion tag still names B.
2. B passes: deliver B. No baseline: valid B still delivers. Neither passes:
   report both reasons and deliver nothing. Current equals baseline: no duplicate
   review or refit. Explicit finalization and budget end behave alike.
3. Fallback after context replacement and process restart retains the baseline,
   original trial root and spent budget; it neither duplicates confirmation nor
   resets the seed/read plan. A later `latest.json` does not hide A's valid receipt.
4. Reject changed source/parameters/data/dependencies, unsafe symlinks, missing or
   corrupt confirmation, broken ledger reservation and stale validation evidence.
   A new proven defect that applies to A prevents fallback to A.
5. Scanner/factory defaults differ from measured parameters: review sees the
   selected values and real population contract. Sandbox tests prove that the
   summary is readable, immutable and contains no sealed/private fields; live
   solutions and raw sibling records remain inaccessible.
6. Keep real SDK free-checkpoint admission tests (including rejected/reused call
   IDs and parallel batches), snapshot/hash-execution checks, no-bash validation,
   development-context exclusion, cancellation, process ownership and arm boundaries.
7. **One vertical deterministic fixture:** scripted lead → completed real trial
   evidence → review of B fails → A selected → real terminal worker → delivery.
   Verify exact ID set, unique binary predictions, output hash, source ZIP,
   selected parameters, one terminal fit and restart idempotence. Use tiny synthetic
   data, no provider. A stub returning `valid: true` and empty artifacts is not
   sufficient evidence for this acceptance test.

Run focused tests first, then serial `./dev bun run test:fast`, typecheck, boundary
checks and full `./dev bun test` before merge, using disk-backed scratch. Preserve
all existing run data and Python journals. Only after these pass should a separate,
explicitly authorized live spam integration run assess delivery and timing. No
model run is included in this planning task.

## Deliberate exclusions and code reduction

- No third agent, recursive review, generic fallback queue, new database or
  scheduler; consolidate current selection code and the duplicated finalization
  decisions instead.
- No new shell/CV execution route. Parameterized `trial_smoke` already exists;
  another smoke tool would duplicate it. The lead's local comparison violation
  remains separately visible; arbitrary Python cannot safely be policed by a
  `.fit` string filter without rejecting legitimate pipeline/check fitting.
- Do not mix interrupted-search promotion (F9), time budgets, larger scout
  allowances, model changes or modeling advice into this repair. They are distinct
  issues, not a prerequisite for retaining a valid baseline.
- Do not resurrect the retired research/evaluate/orchestrator chain or weaken
  hard integrity gates to make the status green.
- Update the current run/team/refit docs and work queue with the implemented
  contract, removing contradictory active instructions. Historical reports stay
  historical. Several README claims still say no live checkpoint run occurred;
  they must not be treated as current readiness evidence.

The first implementation review should reject extra abstractions or persisted
state not needed by A–C. Prefer extracting/reusing verification and replacing
latest-pointer assumptions. A line-count target is not proof of simplicity, but
each new state field must justify why existing trial/receipt records cannot do it.

## Investigation checks completed

- Scripted missing-fallback reproduction: 1 passed, 6 assertions; current broken
  outcome reproduced. Its passing status confirms the reproduction, not the fix.
- Existing lead-session and confirmation-receipt tests: **21 passed, zero failed**,
  241 assertions, 10.75 seconds. This demonstrates the coverage gap; it is not a
  new full-suite or end-to-end-delivery claim.
- Runtime files, model settings and task evidence were not changed. The temporary
  collected probe was removed, and the durable probe is excluded from test
  collection under `runs/`, as intended by `bunfig.toml`.
