# Remaining work

Single work queue for this repository. Updated 2026-11-02. Remove items when
finished; implementation contracts and feature references stay in their own
module documentation. Older handovers and design plans are historical inputs,
not additional active queues.

## Current focus: the two-arm experiment

The minimal agent and the harness now share this branch; see
[experiment.md](experiment.md). Results are comparable only on tasks both arms can run.

Finetuned harness work finished on 2026-11-09 (commits 49e1d78, 6507140):
- every task runs under the orchestrator;
- `online` alone decides fetching, submitting and score feedback;
- offline runs hand over one refit;
- follow-ups (up to three of six trials, 12 h) run on branches from the champion;
- every agent stage writes a stage report and captures lessons (NOTES.md is gone);
- the solve prompt asks for a code self-check before each trial.

Next, in order:
1. Shakedown on spam1–3 offline in both arms, not measured.
2. Shared-drive tasks: re-request the share password, inventory 01–05, get the GPG
   keys, grow the disk, then prepare each task for both arms (instructions,
   labels, CSV contract, `units/index.json` entry, task configuration).
3. Decide the protocol for measured runs: repetitions, sequential or parallel
   arms given MythLLM throughput, and what memory carries over between tasks.
4. Before each measured run: `--arm finetuned --reset --yes`, `--check-setup` for
   both arms.

Open questions:
- The reviewer is told to keep sealed confirmation results out of knowledge
  notes; this is an instruction, not a filter.
- The lesson step adds two model turns per stage.

## Earlier focus: useful signals for the agent

The agent owns experiment ideas, parsing, features and model design. Prioritize
observed execution, progress/cost signals, measured results, comparisons and
shared notes. Do not expand task adapters, promotion gates, sealed confirmation
or terminal refit just to solve the course units. Live-unit validation below is
deferred until needed and access returns; it is not the current development goal.

Experiment history/comparison and shared-note comparison now support learning
from successful and worse attempts, with or without champions. Raw-input cleanup
and strict TypeScript checking are implemented. See the [knowledge module README](../harness/finetuned/agent/knowledge/README.md)
for tool scope, evidence status and reusable lessons.

## Next: research stage redesign

Decided with the user on 2026-11-03; decisions, rationale and sources are in
[research-redesign.md](../harness/finetuned/docs/research-redesign.md). Work in this order and test each
step on spam1–3 before the next overnight run:

- [x] **Harness data profile.** Deterministic, full-corpus, citeable
  records written to the research workspace before the agent starts. The
  generic layer covers all tasks; the text format layer comes first. The
  agent no longer rewrites the survey.
- [x] **Short solution brief.** One recommended pipeline, at most two
  alternates and at most three atomic next improvements. Sources can be any
  profile record, artifact path or URL the harness can resolve, with number
  and URL checks and a self-check tool. Remove the claim-audit and
  Measured/Sampled rules.
- [x] **Solve starts from the brief.** Fit the recommendation as the
  baseline and compare the alternates on the harness hold-out.
Steps 1–5 were implemented on 2026-11-03 and pass the offline tests. Every
tuning value is in `harness.config.json`/`pipeline.config.json`, explained in
[configuration.md](../harness/finetuned/docs/configuration.md).

- [x] **Action budget.** A visible budget line after each tool call, a final
  turn to write the brief, and a `partial` outcome instead of a stage failure.
- [x] **Stall check.** Replace the 30-minute session race with a
  "no streamed tokens for N minutes" check; `session.timeoutMs` stays only as
  a safety limit.
- [x] **Orchestrator re-research.** The orchestrator may rerun research with
  directions drawn from the reviewer's hand-off report (2026-11-09). Few-shot
  examples and a typed diagnosis were not added.

## Exercise 1 results (2026-11-04)

The exercise 1 queue (`runs/exercise1-2026-11-03/`, local and ignored) finished
on 2026-11-04 with all three spam tasks successful, using
`mythllm/qwen3.8-flash-next-a5b` and the redesigned research stage. Validated
CSVs in the official `id;prediction` format (no header, IDs equal to the test
archive, labels 0/1) are in `runs/exercise1-2026-11-03/submissions/`, with the
run history in that folder's `observations.md`. Nothing was uploaded. Scores
are balanced accuracy; "sealed" is the confirmation split the agent never saw,
measured on the frozen champion before terminal refit.

| Task | Champion | Dev CV | Sealed | Test rows (positive) | Readiness |
| --- | --- | --- | --- | --- | --- |
| spam1 | `c53f6572` | 0.99558 | 0.99501 (2 errors / 401) | 15,051 (8,193) | 4 |
| spam2 | `577fa2ad` | 0.99915 | 0.99641 (2 errors / 660) | 12,469 (7,753) | 3 |
| spam3 | `b37d6818` | 0.99886 (20-fold) | 0.99550 (1 error / 712) | 2,757 (417) | 4 |

Advisory review concerns, none of which block submission:

- spam2: the 0.0027 dev-to-sealed gap was not explained (near-duplicate
  leakage across folds was not checked), and the fixed decision offset of -0.1
  was chosen without measuring the score distribution.
- spam3: a page-template flag fires on 59% of training spam but on 8.9% of test
  pages; the test score may be lower if the model relies on those features.

Research redesign in practice: every brief passed validation on the first
attempt, using 29–36 of the 40 tool calls; no model request stalled. Four
infrastructure bugs were found and fixed during the run, each with a regression
test: untyped `experiment_start` fields (the model sent JSON strings), solve
ending while its own trials ran (now `solve.idleWakeMs`), an unbounded research
bash call that exhausted RAM and swap (now `research.bashTimeoutSeconds`), and
handoff context overflow from queued steering messages (now deferred to the
next session, with a harness fallback handoff and `context.handoffTokens`
80,000). Tasks were resumed from their last valid stage, reusing artifacts only
when their hashes were unchanged. The CSV export is still a manual step
(`runs/exercise1-2026-11-03/export_submission.py`, the same conversion as the
submit bundle); see the queue item above.

## Current execution approach: cloud data and manual submission

The model endpoint is now `https://mythllm.mlsec.tu-berlin.de/v1`, with default
model `mythllm/qwen3.8-flash-next-a5b` (the only model returned by the authenticated
model listing on 2026-11-02). Use a separate `MYTHLLM_API_KEY` in the ignored
`.env`; do not send the SAIA credential to this host. Existing shared
`model-configuration` and `model-access` setup checks both passed, including a
minimal live completion through the project adapter. This does not establish
whole-chain readiness. Limits (2026-11-09): the server's `/model/info` now
reports 262,144 input and output tokens. A 130k synthetic probe failed on 2026-11-02,
but a 194,879-token prompt returned a correct answer on 2026-11-09, so the harness
uses 262,144 context (tested to 195k), 32,768 output tokens and reasoning on; the minimal arm keeps
Leo's entry (now in `experiment.config.json`, shared by both arms). Prompts above 195k are untested. The
handoff threshold is 100,000 tokens again (it was 80,000 after a handoff overflowed a 128k window
during exercise 1). Both arms use Leo's `compat` (`system` role) and ask for
`reasoning_effort: xhigh` through the chat template; thinking measurements are in `docs/experiment.md`. SAIA remains an explicit optional provider.

The lab server is unavailable. The user supplied an mlsecCloud share as the
dataset source: `https://cloud.mlsec.tu-berlin.de/s/wD5GSTRbeS8reZH`.
The share is password-protected; keep the password out of repository files.
Read-only authenticated WebDAV listing was verified on 2026-11-02. It contains
`01-spam`, `02-maldoc`, `03-clust`, `04-tor`, and `05-anomaly` directories.
Many archives are separately GPG-encrypted; share access does not establish
that those archives can be decrypted. The listings inspected so far contain
datasets, not verified task instructions or submission-format specifications.

All challenges available in the share are in scope. “Only one” means one final
submission attempt per challenge, not one challenge. The agent may run multiple
local experiments and comparisons, then select its best supported solution when
it judges further work unlikely to improve the result within the run's budget.
There is no official-score feedback loop or automatic resubmission. Local
evidence supports selection; it does not prove the best possible hidden-test score.

The user will send the final CSVs to their professor manually. `submit` is disabled in
`pipeline.config.json`; use research → solve → evaluate → refit to produce
the validated prediction artifact. Do not use an uploading orchestrator command
or infer upload authorization from the availability of data.

- [ ] **Inventory all available cloud challenges.** Include the nested Tor
  directories and map each dataset to its task instructions, labels, encryption
  requirements and output contract. Start with spam1, then work through the
  remaining available challenges; encrypted or unsupported tasks remain tracked
  with their concrete blockers rather than silently omitted.
- [ ] **Prepare each cloud dataset when needed.** Verify its instructions,
  labels, archive contents/identity and CSV contract before declaring it ready.
  Obtain separate decryption credentials if the selected files require them.
  Reuse the existing task/harness path with local data and `--no-fetch`; do not
  fall back to downloading from the unavailable lab server.
- [ ] **Hand over one validated final CSV per challenge.** After the agent
  finishes local search and chooses its best supported solution, freeze and
  refit through the harness, then validate CSV format and test-ID coverage.
  Record each file's path, selected candidate and local validation evidence.
  Evaluation remains advisory, and the harness still validates artifacts.
  Official scoring remains external and manual; do not invent official scores
  or submission receipts.

## Before the first real run (earlier server-based plan)

An overnight local queue was launched on 2026-11-02 for spam1 → spam2 → spam3.
It ended on 2026-11-03 at 00:02 Berlin time with all tasks stopped at research:
spam1 exhausted its retained research budget after the context-test recovery;
spam2 and spam3 hit their 30-minute session timeouts. No task reached training
or produced a final CSV. Model requests took minutes; validated research was
not completed within those budgets. Existing scripts and partial research
measurements are preserved. No workers remain, and the T3 monitor is disabled.
The latency was investigated on 2026-11-03: generation was slow on the server
side, not in tools or our code. The resulting budget and research decisions are
in [research-redesign.md](../harness/finetuned/docs/research-redesign.md). Do not treat these failed
attempts as trained-model evidence.
Operational status, configuration snapshot, input hashes, task results and dated
observations live in `runs/overnight-spam-2026-11-02/`. A T3 task checks it every
ten minutes and disables itself after completion or the overnight deadline.
All three whole-chain preflights passed (including Langfuse and MythLLM) after
adding project-local `.tools/bin/zip`. Existing local datasets require no old
SmartLab server access. Submission stays disabled. The earlier missing-zip and
unverified-service notes below are historical, superseded for this machine by
these checks; VM readiness remains separate. Verify the live status before
starting any other spam pipeline process.

The earlier plan started with spam1: its data and typed task configuration are present locally.
Run the configured research → solve → evaluate → refit chain; it stops before
submission. No real unit 2–4 run has been validated yet.

- [ ] **Restore lab/VPN access (deferred; not required for cloud/manual workflow).** Latest probes on 2026-10-08: the lab website
  and the VM's SSH port both timed out after 10 seconds. This establishes that
  they are unreachable from this machine, not that the servers are down.
- [ ] **Prepare the execution machine.** The local spam1 whole-chain preflight
  reports missing `zip`. The intended execution machine is the SmartLab VM:
  verify its current checkout, transfer the current code and arrange credentials
  securely once reachable. Its last recorded checkout was `e517d34`, without
  a project `.env`; that inventory must be rechecked.
- [ ] **Pass whole-chain preflight on the execution machine.** Verify Python
  dependencies, tools, bubblewrap and working user namespaces, model access,
  and research/solve web-search access. Local tests of filesystem isolation
  do not establish that the VM supports it. Run:

  ```bash
  ./dev bun run pipeline -- spam1 --no-fetch --check-setup
  ```

  The latest local check stopped before service probes because `zip` was
  missing, so model and search access remain unverified for this run.
- [ ] **Run and review spam1 end to end.** Check observed fits, paired champion
  selection, sealed confirmation, evaluation and frozen terminal refit. A
  champion measured on the retired decoded-text frame needs a new raw-input
  promotion. Keep old artifacts; do not silently mix different data identities.
  Submission requires a separate explicit controller policy.

Local validation on 2026-10-09: strict TypeScript checking passes, with 523
TypeScript tests passing, 5 skipped, plus 150 Python tests passing. This is a
baseline, not proof of real-run readiness.
Langfuse Cloud now owns observability; synthetic Cloud write/readback verifies
hierarchy, usage and scores under Bun. JSONL is emergency-only. The custom
dashboard and Postgres writer are removed. See [telemetry.md](../harness/finetuned/docs/telemetry.md).

## Units 2–4: live task validation

- [ ] **Fetch current metadata and required data, then declare tasks.** Only
  unit 1 is currently listed locally and configured in `pipeline.tasks`.
  Verify week-two links and exact archive/target/submission contracts against
  live pages. Download unit 2/3 archives without opening samples for inspection;
  subsequent parsing belongs in controlled analysis code.
- [ ] **Validate raw binary classification on unit 2.** Exercise the raw
  archive/member frame, labels, ID canary, solve isolation, sealed confirmation,
  evaluation and terminal refit on actual task data.
- [ ] **Validate unit 3 clustering.** Confirm family-held-out semantics,
  unseen test families, batch versus inductive execution, prediction domain
  and official output format against live tasks. Binary sealed-confirmation
  scores do not apply to clustering; decide separately if a measured group
  confirmation is needed.
- [ ] **Confirm unit 4.1 pcap identity.** The synthetic adapter uses the first
  observed direction for `ip:port->ip:port`, coalesces both directions and treats
  tuple reuse as one sample. Verify these choices against the official task's
  connection IDs and submission coverage before enabling it. Classic pcap
  support does not establish pcapng or fragmented-traffic support.
- [ ] **Validate unit 4.1 evidence on real data.** Require explicit attack and
  normal labels; unlabelled connections are not negatives. Each scored fold
  needs both classes. Confirm evidence coverage, immutable trial snapshots,
  paired champion replay, evaluation and frozen refit on the official task.

## Unit 4.2: feasibility and generated-image evidence

Evidence-based anomaly selection currently scores labels for known development
IDs. It does not support a separate generated-image challenge population.
Unit 4.2 is not ready for a real run.

- [ ] **Inspect the actual images and task contract when access returns.**
  Establish known-clean controls, the attacked classifier and weights,
  preprocessing and relevant attack families. A predicted class in a filename
  does not establish clean ground truth; perturbing an unknown image does not
  establish a clean/attack pair. If only a surrogate classifier is available,
  declare that scope explicitly.
- [ ] **Add a single image population adapter.** Support tasks without a
  separate test archive consistently across configuration, research, solve,
  preflight, evaluation, refit and submission. Verify exact output coverage
  and official binary mapping.
- [ ] **Freeze generated challenge artifacts.** The solve agent supplies clean
  controls, generated attacks and labels. The harness validates and snapshots
  immutable image bytes, membership, labels, source-image groups, generation
  provenance and attack-verification provenance. A hash of metadata referencing
  mutable files is insufficient. Keep challenge identity separate from the
  original dataset identity.
- [ ] **Implement challenge folds and replay.** Keep a clean source and all its
  variants in the same group; hold out source groups and assess attack-family
  transfer. Inductive fits exclude validation groups. Explicit batch fitting
  remains transductive and receives no scoring labels. Rerun the champion on
  the challenger's exact challenge snapshot and folds; preserve recovery,
  authoritative prediction validation, evaluation and terminal-refit receipts.
- [ ] **Decide the training-label contract if supervised fitting is needed.**
  Scoring evidence does not supply training targets. A supervised detector
  needs a typed path exposing only fold-training labels while validation labels
  remain controller-owned, with matching frozen refit semantics.
- [ ] **Assess ranking and binary decisions separately.** AP does not determine
  a submission threshold. Require the frozen pipeline's binary `predict` and
  report its operating point alongside ranking metrics. Report challenge scope,
  class counts, coverage and limitations: a win on agent-generated evidence
  does not establish performance on official images.

No automatic proxy fallback is authorized. Missing usable evidence remains
advisory. Any future proxy that may select champions needs an explicit declared
objective and a complete paired comparison under that objective. Label-free
clustering promotion also remains an open decision.

## Harness extensions

- [ ] **H1 Remaining task primitives.** Resolve balanced accuracy with missing
  predictions/values when needed. Add only the missing primitives; raw-file, clustering, pcap and
  known-ID anomaly evidence paths should not be rebuilt.
- [ ] **H3 Generic experiment escape hatch.** Expose the existing argv-based
  `agent/experiments/` tools for work outside supported training kinds while
  retaining shared observation and process ownership.
- [ ] **H4 CPU PyTorch support.** Add CPU torch through the environment manager;
  observe epochs and losses, own seeds/checkpoints/resume, and measure clean,
  FGSM and PGD robustness for differentiable models. Units 5 and 6 receive
  signals only; they do not get champions.
- [ ] **H5 Service and download metadata.** Carry service URLs, `/api/...`
  endpoints and non-ZIP download metadata from task pages into the fetcher and
  typed declarations. Then remove the superseded `inspect_lab_data.py` and
  `fetch_lab.py` paths after checking references.
- [ ] **H6 VM lab service.** Locate the units 5/6 Python template and establish
  its API and torch requirements. Declare and probe the VM's service at
  `127.0.0.1:8000`; keep it outside harness-owned cleanup process groups and
  check port ownership before experiments.
- [ ] **H7 Malware and external-service boundaries.** Review runtime tools
  before unit 2/3 agent runs. Samples may only be parsed in analysis code;
  external detection services such as VirusTotal/antivirus are disallowed by
  the lab. Filesystem isolation alone does not prevent network requests.
- [ ] **W1 Tool registry.** Centralize each agent's tools, prompt descriptions
  and setup declarations. Decide whether the orchestrator gets read-only
  knowledge search and which agent gets the VM service tools.
- [ ] **W2 Tool descriptions.** Give orchestrator tools individual authored
  descriptions instead of the shared generic `orchestrator.tool` prompt.

## Hygiene and deletion decisions

- [ ] **T1 Remaining formatting and indexed-access checking.** Strict TypeScript
  checking is part of `./dev mise run test`; nullable identity and related strict
  errors are fixed. Formatter setup and `noUncheckedIndexedAccess` remain deferred.
  Keep any formatting migration separate from behavior changes.
- [ ] **Resolve unused subagents.** Decide whether to wire `agent/subagents/`
  into orchestration or delete it and its `context.*probe*` prompts.
- [ ] **Resolve interactive legacy tools.** Decide whether to retain
  `agent/tools/smartlab.ts` (bypasses the submission ledger) and
  `agent/tools/challenge_context.ts`, currently loaded by interactive pi
  settings. `web_search.ts` remains live.
- [ ] **Retire old instructions after process/reference checks.** Remove
  `agent/instructions/` only after pre-migration processes finish and external
  references are checked; runtime prompts belong in `agent/prompts/`.
- [ ] **Reconcile historical documentation.** Archive or remove superseded
  HANDOVER/WIP/design plans, fix stale README status and commands, and point
  active work tracking here. Keep useful implementation contracts and feature
  documentation; do not maintain competing task lists.
- [ ] **Resolve the VM's `~/.local/bin/herdr`.** Its origin is unknown. Inspect
  and decide whether to keep it when VM access returns.
## Working constraints and references

Run project commands through `./dev`. Use the shared `.venv`, declared
`pyproject.toml`/`uv.lock` dependencies and the environment manager; never raw
pip, separate environments or home-installed toolchains. Setup requires git,
zip, unzip and curl or wget. Keep secrets out of logs and committed task pages.
Every new integration needs bounded shared whole-chain preflight checks and
observability before agents start.

The harness owns folds, seeds, fits, predictions and promotion. The agent owns
features and estimator design. Test inputs remain available; full labels and
sealed rows remain hidden. Champion tags define best; promotion requires a
positive paired lead greater than two standard errors. Evaluation is advisory.
Do not feed sealed confirmation scores back into solve guidance. Pushes,
submissions and VM writes need explicit authorization unless already granted
for the concrete action.

- [Pipeline integration contract](../harness/finetuned/docs/pipeline-integration.md)
- [Harness-owned training](../harness/finetuned/docs/harness-owned-training.md)
- [Training measurements](../harness/finetuned/docs/harness-measurements.md)
- [ID leakage canary](../harness/finetuned/docs/id-leakage-canary.md)
- [Solve filesystem isolation](../harness/finetuned/docs/solve-filesystem-isolation.md)
- [Held-back confirmation](../harness/finetuned/docs/held-back-confirmation.md)

The lab website is `https://lab-test.smartlab.mlsec.tu-berlin.de/` and requires
OpenVPN access and its self-signed TLS handling. The VM is
`stud02.smartlab.mlsec.tu-berlin.de`, with the project last recorded at
`~/smartlab`. Use the gitignored local SSH helper and project-managed known
hosts; never print `.env`, unit pages or VM shell configuration. Official
attempt counters must be refreshed before any authorized submission; historical
counts are not current authority.
