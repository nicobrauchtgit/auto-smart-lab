# Scout budget evaluation, 2026-11-11

Sixteen data/ideas probes completed successfully, one scout at a time, with
10 and 20 tool-call budgets on spam1, spam2, spam3 and code2. Every completed
probe stayed within its cap and returned bullets; none attempted a blocked
post-budget call. Adversarial scripted-provider tests separately exercise the
blocking path. The eight validation cases are **deferred**, not measured:
stream B's immutable trial snapshot/check adapter is unavailable. No live-source
substitute was used.

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

The Calls column counts admitted calls only. Calls Pi rejected before the
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

## Starting budgets and quality limits

Propose **data 15, ideas 10 (at most three searches), validation 10 provisional**.
The data scouts spent every admitted call at both tested budgets. Additional
calls surfaced useful properties such as the spam2 date-window contrast,
spam3 trailing bytes and code2 whitespace-only duplicates. Fifteen is an
engineering starting point between the tested values, not a measured optimum.
A focused repeat question can investigate a particular failed probe or uncertain
claim. Ideas already returned useful material at 9–10 calls; the 20-call cases
used 18–19, with more reading/detail but no demonstrated model-quality gain.
Validation's value is unmeasured until its frozen-source path can run.

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
The P7a scout checks pass at the module boundary: a real scripted Pi child
cannot execute beyond its cap, receives counters/finish feedback, and returns
final text without forwarding tool traffic; the scout tool exposes bullets
only; fixture AGENTS.md instructions stay out while selected team instructions
remain. Tests also cover all-role preflight before any scout, missing search
credentials, separate search caps/logs, durable journal contention/tail repair,
paging/supersessions and stale check hashes. The actual lead integration check
and the P7a lead/resume work remain stream D.

Validation is an explicit unavailable adapter and prompt, built against
expert-team.md section 3. Stream B must supply immutable snapshot resolution,
read-only source, import-origin verification and the check runner before it
can run. Its eight live probes remain deferred. Experiment/commit reference
resolution and authoritative harness-result journal appends also await that
adapter; agent-authored measured-result entries are refused. The read-only
FindingsReader adapter is exported from team/findings.ts for B to re-export
from workspace/findings_reader.ts without duplicating its projection.

Shared-file changes: only the team block/validation in harness.config.json and
agent/harness/config.ts; team prompt registry entries; and the scouts shared
preflight requirement (prompts, unit intro and writable findings destination).
The subagent factory now accepts host-selected tools, guards and role prompts,
and can disable its legacy wall timer for scouts; scouts use the
`team.scoutGuard` stall guard instead. Later review fixes added `scoutGuard` to
harness.config.json, agent/harness/config.ts and the expert-team-v2.md
configuration block; optional `scoutPaths` to `setupChecks`; and the
`scout-probe` stage name to the pipeline trace type. The setup command's generated
Python audit records were retained; dependency declarations and lockfile were
not changed. agent/dryrun/ was absorbed and deleted. No minimal-arm files were
changed. Supervision and lead/hand-over integration remain their named streams.
