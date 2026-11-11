# Scout budget evaluation, 2026-11-11

Sixteen data/ideas probes ran, one scout at a time, with 10 and 20 tool-call
budgets on spam1, spam2, spam3 and code2. Every probe returned scout-written
bullets: none of the sixteen tracked replies holds an error, stop or
no-evidence line. (The probe then recorded success whenever the scout call
returned, even for a failed or stopped scout; it now records those outcomes
separately.) Every probe's admitted calls stayed within its cap, and none had
a blocked post-budget call. Admitted calls are not proven executions: the
probes ran on a budget that admitted by tool-call ID, under which a reused ID
could execute more than once for one counted call. The summaries do not record
executions or IDs; the Langfuse traces could show them but were not checked.
Adversarial scripted-provider tests separately exercise the blocking path.

The eight validation cases ran later the same day, after the integration with
stream B, on measured trial snapshots (plus one extra repeat of spam1 at 10
calls): see [Validation probes](#validation-probes). The starting budgets
follow from both sets: **data 15, ideas 10 (at most three searches),
validation 10**.

## Protocol and artifacts

Provider: `experiment.config.json`, mythllm/qwen3.8-flash-next-a5b. Each probe
works alone, with task text and unit introduction, no earlier data scout
findings, and its own journal. Ideas has at most three web searches. Code2 uses
a local probe-only declaration from its supplied clustering task text; the
pipeline configuration was not changed. Corpus programs were not execution
targets; the question explicitly requires inspecting bytes/text only.

Calls count admitted scout tool attempts, including tool errors; model preflight
requests are separate. Seconds run from after initial staging/profiling through
preflight, scout completion and findings append, excluding final trace flush.
This is not end-to-end task latency. These are one development probe per cell,
not a controlled replicated experiment or a model-quality comparison.

The first spam1/data/10 probe used the migrated standalone opening and saved
its raw reply. Subsequent probes use the blocking service with task/unit text
inline and bullet normalization. All spam1 probes used the legacy session
runner; spam2 onward used the child-session backend. The ideas prompt's optional
prior-data wording was corrected before spam3; long-bullet citation clipping
was fixed before the code2 ideas probes. These changes limit comparisons,
especially the spam1 data pair. Full session traffic remains in the shared
Langfuse trace; local JSON summaries and journals are experiment artifacts.

[Machine-readable results](budget-results/results.json) and the per-case
final bullets linked below are tracked copies in `budget-results/`. The
interactive calls/time chart (`results.html`), batch launch scripts, logs,
aggregation helpers, per-probe journals, profiles and research folders stay
local only, under the gitignored `runs/finetuned/scout-budget/` and
`runs/finetuned/scout-dry-run/` of the worktree that ran the probes.

There are 17 probe directories: the sixteen in the table, plus
`2026-11-11T13-30-23-spam1-data-10`, an aborted first start that holds only an
empty `research/` folder (no bullets, summary or journal). It is not counted.

The probes ran with the full task folder mounted read-only and a data profile
of the full training and test data. Stream B's TaskData gives scouts the
development split only, so calls, timings and surfaced properties may differ
under the pipeline's real view.

The Calls column counts admitted calls only, not executions (see above). Calls Pi rejected before the
budget hook (unknown tool name, invalid arguments) were not counted at the
time; none of the summaries records how many there were. The budget now
counts every emitted call at its assistant message, so a rerun could report
higher numbers for the same behaviour. The probes were not rerun.

## Measurements and what the scouts surfaced

The descriptions below summarize **attributed scout claims**, not independent
verification or harness trial evidence. Raw bullets retain their own sources.

| Task | Scout | Budget | Calls | Seconds | Bullets | Surfaced |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| spam1 | data | 10 | 10 | 257 | [16](budget-results/bullets/2026-11-11T13-30-31-spam1-data-10.md) | Subject-only normalized mail; spaced URLs missed by profile; embedded labels entry; long test tail. |
| spam1 | data | 20 | 20 | 375 | [12](budget-results/bullets/2026-11-11T13-35-03-spam1-data-20.md) | Near-duplicate probes, vocabulary coverage and Enron-specific train/test contrasts. |
| spam1 | ideas | 10 | 10 | 134 | [15](budget-results/bullets/2026-11-11T13-41-23-spam1-ideas-10.md) | Content/structure features, preprocessing and class/threshold considerations from samples, slides and searches. |
| spam1 | ideas | 20 | 19 | 223 | [12](budget-results/bullets/2026-11-11T13-43-38-spam1-ideas-20.md) | Normalization, random-word padding and domain-specific ham markers; additional representation ideas. |
| spam2 | data | 10 | 10 | 194 | [14](budget-results/bullets/2026-11-11T13-47-23-spam2-data-10.md) | RFC-822/MIME structure, header contrasts, mixed charsets and embedded labels entry. |
| spam2 | data | 20 | 20 | 347 | [14](budget-results/bullets/2026-11-11T13-50-47-spam2-data-20.md) | Train/test date-window differences; full-corpus header, charset and MIME observations. |
| spam2 | ideas | 10 | 10 | 79 | [11](budget-results/bullets/2026-11-11T13-56-47-spam2-ideas-10.md) | Header/body representations, MIME handling and mail-header feature ideas. |
| spam2 | ideas | 20 | 19 | 155 | [13](budget-results/bullets/2026-11-11T13-58-07-spam2-ideas-20.md) | Host-dependent spam-header scores, alternative MIME parts, charset and metadata normalization. |
| spam3 | data | 10 | 10 | 155 | [16](budget-results/bullets/2026-11-11T14-00-44-spam3-data-10.md) | HTML pages, class imbalance, doorway templates; a near-duplicate probe failed and was labelled unverified. |
| spam3 | data | 20 | 20 | 344 | [10](budget-results/bullets/2026-11-11T14-03-23-spam3-data-20.md) | Bytes after closing HTML tags, structural contrasts, size bounds and vocabulary differences. |
| spam3 | ideas | 10 | 10 | 97 | [14](budget-results/bullets/2026-11-11T14-09-11-spam3-ideas-10.md) | Separate visible text, HTML structure and link features; course-resource connections. |
| spam3 | ideas | 20 | 19 | 184 | [20](budget-results/bullets/2026-11-11T14-10-49-spam3-ideas-20.md) | Additional HTML/link/anchor representations, boilerplate and class/threshold considerations. |
| code2 | data | 10 | 10 | 146 | [12](budget-results/bullets/2026-11-11T14-13-54-code2-data-10.md) | CR-only line layout, imbalanced families, encoded/image-prefixed scripts and near-copy observations. |
| code2 | data | 20 | 20 | 315 | [18](budget-results/bullets/2026-11-11T14-16-22-code2-data-20.md) | Whitespace-only duplicates, compact scripts, embedded script payloads and train/test language contrasts. |
| code2 | ideas | 10 | 9 | 93 | [12](budget-results/bullets/2026-11-11T14-21-39-code2-ideas-10.md) | Static representations and similarity for unseen families; avoid assuming test has the four known families; calls the filename suffix label leakage. |
| code2 | ideas | 20 | 18 | 195 | [14](budget-results/bullets/2026-11-11T14-23-13-code2-ideas-20.md) | Sparse similarity, normalization and threshold/cluster-count cautions; calls the filename suffix label leakage. |

## Validation probes

**Protocol.** After the integration with stream B (commits d7345db and
2a3c177), `probe_trial.ts` ran one harness-owned trial per task through
`createHarnessTraining` under the solve sandbox, on stream B's TaskData
(development split only). The trial pipelines are deliberately minimal: hashed
word counts and balanced logistic regression for spam1–3 (the same file for all
three), TF-IDF and average-linkage cosine clustering with
`distance_threshold=0.8` behind `fit_predict` for code2. Each validation
probe got that trial's frozen snapshot read-only, `checks/<task>/` as its only
writable folder, the `run_checks` tool, and the question in
`prompts/team/probe-validation.md`. Same provider as above. Calls now count
every emitted call; no probe had a call blocked after its budget.

| Task | Budget | Status | Calls | Turns | Bullets | Seconds | Checks written |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| spam1 | 10 | completed (extra repeat) | 10 | 6 | [11](budget-results/bullets/2026-11-11T20-33-56-spam1-validation-10.md) | 161 | 0 |
| spam1 | 10 | completed | 10 | 11 | [10](budget-results/bullets/2026-11-11T20-37-35-spam1-validation-10.md) | 199 | 1 |
| spam1 | 20 | completed | 20 | 12 | [5](budget-results/bullets/2026-11-11T20-40-55-spam1-validation-20.md) | 304 | 2 |
| spam2 | 10 | completed | 10 | 8 | [7](budget-results/bullets/2026-11-11T20-46-00-spam2-validation-10.md) | 221 | 1 |
| spam2 | 20 | empty (parser bug; [7 recovered](budget-results/bullets/2026-11-11T20-49-42-spam2-validation-20.reply.md)) | 19 | 20 | [0](budget-results/bullets/2026-11-11T20-49-42-spam2-validation-20.md) | 494 | 3 |
| spam3 | 10 | completed | 10 | 8 | [8](budget-results/bullets/2026-11-11T20-57-57-spam3-validation-10.md) | 225 | 1 |
| spam3 | 20 | empty (parser bug; [6 recovered](budget-results/bullets/2026-11-11T21-01-43-spam3-validation-20.reply.md)) | 19 | 17 | [0](budget-results/bullets/2026-11-11T21-01-43-spam3-validation-20.md) | 343 | 4 |
| code2 | 10 | completed | 10 | 11 | [6](budget-results/bullets/2026-11-11T21-07-26-code2-validation-10.md) | 186 | 1 |
| code2 | 20 | completed | 20 | 14 | [5](budget-results/bullets/2026-11-11T21-10-33-code2-validation-20.md) | 224 | 3 |

Bullets count what the probe recorded, including lines the journal refused.
The summaries are in [`budget-results/summaries/`](budget-results/summaries/).
"Checks written" counts the check files under
`runs/finetuned/solutions/checks/<task>/` whose modification times fall in the
probe's run window; it is not recorded by the probe.

The first spam1/10 run is an extra repeat. It started minutes before 2a3c177
changed the probe question, under the earlier wording "inspect bytes/text only;
never execute corpus members", so it wrote no check and validated by reading
code alone. The question was then changed to allow checks that fit and predict
with the snapshot's pipeline on development data, and spam1/10 was run again.
Only the second spam1/10 run is the measured cell.

**The two empty 20-call runs** (spam2 and spam3) were a harness bug, not a
model failure. Their Langfuse traces (`9d4bbeda27220ae10eb1d3855673d794`,
`76a5d2c3aac9717292f959f54e407939`) show both scouts using 19 of 20 calls,
then ending on their own with a normal `stop` turn (turn 20 and 17 of at most
22). Neither hit the budget or turn limit, so no finish-up turn was involved.
Their final text held 7 and 6 well-sourced findings, each starting with a
label, but written as `**ok:** …` lines (spam2) or `` `ok:` … `` paragraphs
(spam3) with no `- ` list marker. `finalBullets` kept only list items, found
none, and the probe recorded the role as empty, with "No sourced findings
returned" as the lead's text. The prompt asks for "short bullets, each starting
with `ok:`, `fix:` or `advice:`", and the labels were there. Fix: for
validation, a line that starts with a label now opens a finding even without a
list marker (`scouts.ts`, `finalBullets(..., {labelled: true})`). Prose that
merely mentions a label ("OK — here is…") still does not. Replaying the traced
replies through the fixed parser recovers 7 findings (5 ok, 2 advice) and 6
findings (4 ok, 2 advice). The verbatim replies are tracked as
`*.reply.md` next to the recorded bullets.

**What validation found.** No probe snapshot has a real defect of the kinds the
prompt names (fold leakage, fitting on test inputs, wrong output domain,
forbidden inputs). So these probes measure evidence quality and false positives,
not whether a real defect is caught. A trial with a seeded defect was not
probed.

- spam1 (10: 6 ok, 3 advice; 20: 3 ok, 1 advice). Both measured runs fitted
  the pipeline on a development split (balanced accuracy 0.9769 and 0.9762),
  checked the output domain, and confirmed that member bytes, not names, are
  the features. The 20-call run also verified row alignment under permutation
  and counted fits to show nothing is fitted at predict time. Each run had one line of its own check
  failing, with no `ok:`/`fix:`/`advice:` label (10) or a mislabelled
  "fix (my check, not the pipeline)" (20). The journal correctly refused both
  lines and the lead text says so. The extra repeat's advice that
  `HashingVectorizer` is "left at `norm=None`" is **wrong**: its default is
  `norm='l2'`, which the spam3/20 check printed.
- spam2 (10: 5 ok, 2 advice; 20 recovered: 5 ok, 2 advice). Name suffix and
  target agree on 18096/18096 rows and the suffix is not a feature. A
  shuffled-label control gives AUC 0.49, and 3-fold CV balanced accuracy is
  0.9943. Predictions are invariant to row permutation. The archive holds
  exactly the sample members. Advice: decoding loses binary/latin-1 MIME parts;
  check whether `class_weight="balanced"` suits the test prior. One slip: the
  10-call run says `profile.json` "targets accuracy-style scoring", but the
  profile names no metric.
- spam3 (10: 5 ok, 3 advice; 20 recovered: 4 ok, 2 advice). A corpus whose
  pages are identical and whose names alone carry the label gives balanced
  accuracy 0.500, so names do not leak. 5-fold OOF balanced accuracy is 0.9978,
  `.x`-renamed members predict normally, and there are 0 exact-duplicate
  groups. Advice: the three spam tasks share one byte-identical file (extract a
  shared `lib/` module), the features are word-only, and near-perfect dev scores
  mean dataset separability.
- code2 (10: 2 ok, 2 fix, 2 advice; 20: 2 ok, 1 fix, 2 advice). Both confirmed
  that features come from member bytes only. The 10-call run did so with fake
  member names and targets; the 20-call run compared `fit_predict(frame, y)`
  with `fit_predict(frame)`. Both `fix:` findings about the interface are
  **wrong**. They report that `SourceClusters` lacks `fit`/`predict`, but the
  harness drives batch clustering through `fit_predict` alone
  (`training/python/smartlab_trial/agent_code.py` requires only that). The
  cause was the solutions README, which stated only `fit(X, y)` and
  `predict(X)`; it and the validation prompt now say that batch clustering
  needs only `fit_predict`. The 10-call run's second `fix:` (threshold 0.8
  "groups nearly everything together") is a quality judgement filed as a
  defect, and its direction is wrong. Its own numbers (25 clusters for 2
  families, one 502-row cluster, the 21-row family spread over about 24
  clusters) show over-splitting, which is how the 20-call run correctly
  reported it as `advice:` (completeness 0.254, ARI 0.492).

**Labels from file names.** No probe flagged reading labels from member names
as a defect. Every run that discussed it treated it as the course's delivery
and checked that names do not reach the features. Seven of the nine backed this
with an executed check: name/target agreement, name-only or shuffled labels,
`.x`-renamed members, or fake names and targets. The extra spam1 repeat read
code only, and the spam1/20 suffix-invariance sub-test never ran. The remaining false positives concern
the clustering interface (now stated in the README and prompt) and one
mislabelled quality finding.

**Budget.** At 10 calls all five runs completed with 6–11 labelled bullets in
161–225 s and ran one check each. At 20 calls they wrote 2–4 checks and took
224–494 s. The extra checks (fit counting, shuffled-label and row-alignment
controls, clustering structure) made the evidence stronger. They did not
change a conclusion: the same false code2 interface finding appeared at both
budgets. Validation starts at **10**; the lead can make a focused repeat call
when it needs more checks.

## Starting budgets and quality limits

Set: **data 15, ideas 10 (at most three searches), validation 10**, in
`harness.config.json` (`team.scouts`) and expert-team-v2.md section 3.
The data scouts spent every admitted call at both tested budgets. Additional
calls surfaced useful properties such as the spam2 date-window contrast,
spam3 trailing bytes and code2 whitespace-only duplicates. Fifteen is an
engineering starting point between the tested values, not a measured optimum.
A focused repeat question can investigate a particular failed probe or uncertain
claim. Ideas already returned useful material at 9–10 calls; the 20-call cases
used 18–19, with more reading/detail but no demonstrated model-quality gain.
Validation completed at 10 calls on every task; 20 calls added checks but no
different conclusion (see [Validation probes](#validation-probes)).

The basis has limits: one probe per cell (spam1/validation/10 ran twice), one
provider and model, development probes with prompt and backend changes between
the data/ideas runs, and no quality comparison. Findings were not graded
against a reference, and no seeded-defect trial was validated.

More calls did not make every statement reliable. Some bullets infer “no
leakage” from zero exact duplicates, recommend split/model details outside the
scout's role, or overstate dataset generalization. The code2/data/20 reply calls
the extra archive member `labels`; an independent Python `zipfile.namelist()`
review confirms its name is **`php-train.labels`**, as the 10-call scout said.
Both code2 ideas replies (10 and 20 calls) call the stated filename-label fact
label leakage; the 20-call reply also suggests blanket filename restrictions.
At the time only the data prompt stated that fact; the shared scout
instruction now gives it to every role, and the validation prompt says it is
not a defect. Those suggestions were not installed
as harness constraints. Earlier long bullets could lose a trailing citation
when clipped; the final implementation preserves complete lead replies and
separately bounds journal prose while retaining structured references. Further
fixed-task prompt evaluation should address semantic role/source accuracy.

## Checks and remaining integration

Commands run through the pinned project toolchain:

```
./dev bun test harness/finetuned/agent/team harness/finetuned/agent/subagents harness/finetuned/agent/prompts
./dev bun run typecheck
```

Result when the probes ran: **40 tests passed, 0 failed; typecheck passed**.
After the review fixes: **56 tests passed, 0 failed; typecheck passed**. No
full suite was run. The review-fix tests add: scripted Pi children that emit
only malformed calls (unknown tool, invalid arguments) stop within budget plus
two turns and still return bullets; a hung child is stopped by the stall
guard; strict lead refs; partial journal appends; numbered and continued
bullets; per-role failures; the bounded repeat view; status paging; citation
roots and pending experiment refs; the scout-prompts preflight; and the
runner's per-role tool set and mounts.
Those 56 tests overstated two guarantees. A scripted child could not execute
beyond its cap only while every call had a distinct ID: admission was by ID
and never consumed, so with budget 1 several calls sharing one ID all ran, and
the finish-up turn could reuse it. The stall guard returned a stop bullet but
then stopped waiting for `close()` after 30 s; a provider that never settled
left the session, its observer subscription and pending work in place.
After the second review fixes: **62 tests passed, 0 failed; typecheck
passed**. The added tests: scripted Pi children reusing one tool-call ID within
a message and in the finish-up turn, on Pi's parallel and sequential paths,
execute exactly the budget (the old budget executed 7 of 3); a hung provider
in a real sandboxed data scout is terminated (session disposed once, no
listener left, observer closed, no tool process left; it fails if the stopped
session is merely closed); a hung sandboxed `sleep` leaves no process once the
guard fires; and failed, guard-stopped and empty scouts get their own status,
their harness line is neither a bullet nor a journal entry, and the probe
outcome is unsuccessful.
The P7a scout checks pass at the module boundary: a real scripted Pi child
cannot execute beyond its cap, including when it reuses tool-call IDs,
receives counters/finish feedback, and returns final text without forwarding
tool traffic; a stuck scout is terminated with its tool processes; the scout
tool exposes bullets only; fixture AGENTS.md instructions stay out while selected team instructions
remain. Tests also cover all-role preflight before any scout, missing search
credentials, separate search caps/logs, durable journal contention/tail repair,
paging/supersessions and stale check hashes. The actual lead integration check
and the P7a lead/resume work remain stream D.

Round 2 (after merging `v2-clean-slate` with stream B) replaced the unavailable
validation adapter. Validation resolves each call's experiment to B's verified
trial snapshot. It gets a fresh sandbox per call (snapshot read-only,
`checks/<task>/` writable) and a `run_checks` tool on B's check runner.
Experiment and commit references resolve through B's snapshot resolver.
Shared contract types live once in `team/contracts.ts`, and
`workspace/findings_reader.ts` re-exports the reader. B's `webSearchExtension`
replaced `team/search.ts`. Scout inputs come from B's TaskData, with the unit
introduction delivered once and a `research/` folder. The
[validation probes](#validation-probes) ran on that path.
Agent-authored measured-result entries are still refused.

After the validation probes, `finalBullets` accepts label-led validation
findings without list markers, and the solutions README and validation prompt
state that batch clustering needs only `fit_predict`. Tests: "validation
findings written as labelled lines or paragraphs without list markers are kept"
(scouts.test.ts), "a validation reply of labelled paragraphs completes and
journals its findings" (integration.test.ts), and the validation prompt
assertion in "every role gets the shared label-suffix fact".

Shared-file changes: only the team block/validation in harness.config.json and
agent/harness/config.ts; team prompt registry entries; and the scouts shared
preflight requirement (prompts, unit intro and writable findings destination).
The subagent factory now accepts host-selected tools, guards and role prompts,
and can disable its legacy wall timer for scouts; scouts use the
`team.scoutGuard` stall guard instead. Later review fixes added `scoutGuard` to
harness.config.json, agent/harness/config.ts and the expert-team-v2.md
configuration block; optional `scoutPaths` to `setupChecks`; and the
`scout-probe` stage name to the pipeline trace type. The second review fixes
added a forced `terminate()` to `SmartContextSession` (agent/context/session.ts,
with an optional handle method) and to the Pi child session
(agent/subagents/pi.ts); `close()` is unchanged for every other caller. The setup command's generated
Python audit records were retained; dependency declarations and lockfile were
not changed. agent/dryrun/ was absorbed and deleted. No minimal-arm files were
changed. Supervision and lead/hand-over integration remain their named streams.
