# Remaining work

Single work queue for this repository. Updated 2026-10-09. Remove items when
finished; implementation contracts and feature references stay in their own
module documentation. Older handovers and design plans are historical inputs,
not additional active queues.

## Current focus: useful signals for the agent

The agent owns experiment ideas, parsing, features and model design. Prioritize
observed execution, progress/cost signals, measured results, comparisons and
shared notes. Do not expand task adapters, promotion gates, sealed confirmation
or terminal refit just to solve the course units. Live-unit validation below is
deferred until needed and access returns; it is not the current development goal.

Experiment history/comparison and shared-note comparison now support learning
from successful and worse attempts, with or without champions. Raw-input cleanup
and strict TypeScript checking are implemented. See the [knowledge module README](../agent/knowledge/README.md)
for tool scope, evidence status and reusable lessons.

## Before the first real run

Start with spam1: its data and typed task configuration are present locally.
Run the configured research → solve → evaluate → refit chain; it stops before
submission. No real unit 2–4 run has been validated yet.

- [ ] **Restore lab/VPN access.** Latest probes on 2026-10-08: the lab website
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
dashboard and Postgres writer are removed. See [telemetry.md](telemetry.md).

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

- [Pipeline integration contract](pipeline-integration.md)
- [Harness-owned training](harness-owned-training.md)
- [Training measurements](harness-measurements.md)
- [ID leakage canary](id-leakage-canary.md)
- [Solve filesystem isolation](solve-filesystem-isolation.md)
- [Held-back confirmation](held-back-confirmation.md)

The lab website is `https://lab-test.smartlab.mlsec.tu-berlin.de/` and requires
OpenVPN access and its self-signed TLS handling. The VM is
`stud02.smartlab.mlsec.tu-berlin.de`, with the project last recorded at
`~/smartlab`. Use the gitignored local SSH helper and project-managed known
hosts; never print `.env`, unit pages or VM shell configuration. Official
attempt counters must be refreshed before any authorized submission; historical
counts are not current authority.
