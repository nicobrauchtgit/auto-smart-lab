# Spam1 tool-choice diagnostic: second observation

The user requested a second fresh 30-minute observation after the
[first live diagnostic](spam1-live-tool-choice-2026-11-12.md). The question was
whether its early execution choices would recur, not which spam classifier
would win. No old source, feature advice, first-run explanation or interface
correction was supplied to the new runtime lead.

## Conditions and evidence

- Checkout: `v2-clean-slate`, `346db16`, initially clean. No runtime code,
  prompts, provider configuration or tools changed between observations.
- Configured offline model: `mythllm/qwen3.8-flash-next-a5b`.
- Launch: **17:13:30.878 UTC**, hard deadline **17:43:30.878 UTC**, including
  setup, validation and refit. The same typed guidance reserved the final ten
  minutes, requesting terminal finalization by **17:33:30.878 UTC**. The captured
  lead opening contains both UTC times.
- Lead/training invocation: `5508cd3c-e5a7-4f21-bd15-091694897eb5`.
- Pipeline: `f7c3601e-3cb6-4510-8a16-14ffab07b0d6`.
- Lead agentRunId: `ee58df99-1d8b-41a7-9e20-8bac7ae306d4`.
- [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/9395d4c170a958047b00bc690bc902ba).
- Launch records, authoritative outer supervisor receipts, health samples,
  operator observation snapshots and controller:
  `runs/launches/2026-11-12T17-13-07Z-spam1-tool-choice-diagnostic-2/`.
- Fresh task state: `runs/finetuned/spam1/`; fresh shared solutions:
  `runs/finetuned/solutions/`. Prior task state/solutions were renamed into
  `runs/archives/2026-11-12T17-13-07Z-spam1-tool-choice-diagnostic-1/`, with Git
  worktree pointers repaired after relocation. Prior deliveries, archives,
  diagnostics and setup journals were preserved. Nothing was reset or resumed.

Before the subsequent
[live interface verification](spam1-interface-verification-2026-11-12.md), this
second diagnostic's `spam1/` and `solutions/` trees were moved intact into
`runs/archives/2026-11-12T19-27-17Z-spam1-tool-choice-diagnostic-2/`.
Task-state and operator-answer paths below now resolve under that archive;
launch/observer records and historical deliveries remain at their original
locations.

The lead-system template and rendered hashes match the first observation:
`dede994a3d4d2978914f55135fc7829b101c0ad38ce371348d978f8c9f7d7155`
and `e2548874b41fccf949a36f2c2c6a7299cb584b3b61d2fd67e26c074e19858afd`.
The opening/guidance rendering changed to carry the new deadline.

The production whole-chain preflight passed before the lead started, including
the tiny configured-model probe. No extra diagnostic model session or provider
retry was launched. The controller reused the first observation's existing
`ExperimentSupervisor` integration and disk-backed scratch/health records.

## Actual harness execution

The lead first committed its pipeline at **17:20:10.427**, source `41f14d5`.
`workspace_check` rejected index entries with an extra `solutions/` prefix;
the lead corrected the index in `e06f84d` at **17:21:34.227**.

Smoke attempts at **17:21:46.048** and **17:21:51.014** were rejected for CV
schema errors. They executed no model fit. Smoke workers at **17:22:05.584**
and **17:22:47.220** failed at module loading, using `tasks/spam1.py` and
`runs/finetuned/solutions/tasks/spam1.py`, respectively. Their traceback-bearing
responses did not establish an estimator fit or consume a trial unit. Lead
tool calls still counted for these attempts.

At **17:29:00.633**, a request naming `solutions/tasks/spam1.py` passed the
harness smoke. At **17:29:20.037**, `experiment_start` accepted a single fixed
five-fold stratified promotion trial, persisted as started at **17:29:22.637**:
`77a4c40a-e2d7-42fc-875b-e30c13475514`, source
`77d5626a9f03a8c4b7cdeca8a946cdbc36af6dae`.

The measured pipeline used word/character TF-IDF, structural features and a
class-balanced logistic classifier at its defaults. The optional linear-SVM
branch was defined but was not a measured alternative in this trial. Feature
and scaler fitting inside that worker were legitimate harness-owned pipeline
execution, not local candidate comparison.

The trial completed at **17:31:29.334**, became champion, and recorded
development CV balanced accuracy **0.9919526542164072**. It took approximately
127 seconds from persisted start to result. No parameter search or challenger
comparison had been executed at that point.

## Actual local execution

Local shell actions inspected the workspace, archive layout, development and
unlabelled test samples; wrote implementation/index files; committed source;
and investigated path resolution. An unavailable `unzip` command failed, after
which the lead used Python. Attempts to inspect harness loader implementation
files failed because those files were absent from its sandbox view.

At **17:27:43.719**, it created a `solutions` link in the shell's synthetic
project root and committed `solutions -> .` inside the writable shared
solutions repository (`e9a73d8`). At **17:28:21.502**, it changed normalization
and tokenization before its first measured baseline (`77d5626`), attributing
the change to a scout's input-distribution finding. Source inspection verifies
the edit actually occurred. Input statistics motivated this hypothesis; they
do not measure its predictive benefit.

The successful smoke also changed the request's module spelling. Therefore its
success cannot be attributed specifically to the symlink workaround. The first
run had succeeded with that request spelling without this workaround. No host
repository boundary was widened to help the lead.

All **26 authoritative lead-shell receipts** were inspected. No local estimator
fit, calibration run, CV loop or candidate sweep was recorded through run end.
This differs from the first observation's
one pre-smoke local construction fit. Both leads continued trying harness
execution after request/path failures.

## Live reasons and interventions

Two focused operator questions were sent to the original live session through
`ask_lead.ts`. Their answers remain in
`runs/finetuned/spam1/lead/operator/answers/`. Behavior after each intervention
is not an untouched observation. No model or interface fix was suggested.

1. **17:26:47.014**, question `2026-11-12T17-26-47-014Z-86acaa`: what the
   path inspections were establishing, how it chose local versus harness fits,
   and whether feedback/cost/latency mattered. The lead said the index checker
   and loader appeared to use different roots; its goal was resolving that
   ambiguity. It cited unreadable loader source and deadline/round-trip latency
   for its symlink workaround, and stated that no local command had fitted a
   model. It assigned correctness fits to smoke and model evaluation to trials.
2. **17:30:42.267**, question `2026-11-12T17-30-42-267Z-124fbf`: what determined
   the first trial's scope and the choice between another comparison and
   finalization. The lead described baseline establishment, choosing the
   suggested five-fold scheme and promotion scope, avoiding a multi-parameter
   search under the deadline, and reserving time for validation/refit. Its
   stated plan was to finalize once the champion result arrived.

These are self-reports. The recorded absence of local fits, fixed request and
request repairs support its description of where it executed work. The index
and module-loading failures support its report of interface friction. They do
not prove that latency caused its particular workaround. Its statement that
every failed smoke was a module-loading failure omits the two earlier schema
rejections. Its claims about pilot cost and repeat cost were not measured
comparisons; its explanation should not be treated as an accurate cost model.

The repeated observation supports a narrower finding than a general behavioral
rule: path/schema friction recurred, and this lead persisted with the harness
without local fitting. The earlier local construction check did not recur.
Neither bounded observation recreated run 3's interrupted multi-candidate
search followed by a local sweep. Deadline pressure left little room for that
kind of improvement cycle. No new causal conclusion about run 3 is warranted.

## Terminal outcome and resource safety

The lead requested terminal `hand_over(finalize: true)` at
**17:32:46.412 UTC**, before the typed finalization-reserve boundary. Readiness
validation completed at **17:40:50.706**, about eight minutes later, recording
the measured baseline and changing phase to improvement. The run nevertheless
ended **failed** at **17:41:03.904**, with `stop_reason: refit_failed` and process
exit code 1: approximately **27m33s after launch**, before the hard deadline.
There was no controller timeout or machine-risk stop.

The exact terminal error was **`Frozen source cannot contain symlinks`**.
The committed workaround `solutions -> .` was a Git mode `120000` entry in
measured source `77d5626`. The lead removed that link in the live tree and
committed `4fd85375316058e307a78dead81a43381793e5f6` at **17:32:30.687**, before
requesting terminal hand-over. Its hand-over reason explicitly claimed the
shims had been removed. But no trial measured that later revision. The
authoritative champion still referenced `77d5626`, and
`inspectRefitCandidate` checks the tree of that measured champion commit, not
live HEAD (`harness/finetuned/agent/refit/service.ts`, source-integrity and
symlink check). Git trees, the single trial request/invocation, and the final
stage error corroborate this failure path. It was not an estimator crash,
failed CV measurement or validation-scout defect verdict.

Thus the workaround had a concrete downstream consequence even though it was
later removed locally: the accepted measured source was ineligible for the
terminal freeze. Terminal refit fitting did not execute and no new delivery
was produced. Existing delivery folders are historical: `57f7c6b73f2b` dates
to 2026-11-11 and `c2f3fc664b7a` belongs to the first observation. The first
delivery's output hash was rechecked and still matches its manifest. No
repair, remeasurement, extra model session or further run was attempted after
this failure; the failure and source history are preserved for review.

The controller recorded peak aggregate descendant RSS of approximately
**2,666 MiB**. Five-second health samples stayed above **10,566,008,832 bytes**
free disk (about 9.84 GiB) and **12,309,484 KiB** available RAM (about 11.74 GiB).
These are sampled minima. After exit, birth-identified tracked members were
all gone, and neither the controller nor launcher process remained. No host
root `solutions` symlink existed; the synthetic-root shell link did not widen
the host workspace. Scout tool-command/source inspection also found data
summary and validation inspection work, with no separate estimator comparison;
scout transcripts are not reproduced.

No uploads, submissions, pushes, minimal-arm edits or code2 runs occurred.
All run state, source commits, observer records, prior archives and setup
journals were preserved. Only documentation was changed in the development
checkout.

No runtime implementation changed for this repetition. The existing prompt/
guidance and fast-suite results recorded in the first report apply to the
unchanged runtime revision; no new development test suite was needed for this
documentation-only observation. Full tests remain required before merging.
