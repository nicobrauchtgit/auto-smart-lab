# Prompt-first spam1: first validated delivery

This unmerged experiment changes only the registered lead system and hand-over
tool prompts. The first priority is a committed simple pipeline, construction
smoke, a real harness trial, and immediate validation of the first champion.
Concrete defects require correction and remeasurement. Speculative improvements
are recorded for later runs. The tool prompt's previous suggestion that repeated
hand-over could accept unresolved defects contradicted production and is removed.

The experiment's immutable typed `lead` guidance explicitly requests a first
validated offline delivery within **600 seconds from task launch**, including
setup. It supplies launch time and UTC deadline through the existing guidance
template and hash mechanism. This is this experiment's goal, not a generic
harness time limit. No model, feature, CV choice or numerical score is prescribed.
Runtime remains offline MythLLM as configured; no uploads are authorized.

Success requires approved hand-over validation, successful terminal refit,
`output.csv`, `source.zip` and `manifest.json`, matching prediction checksum,
and pipeline success before the deadline. Smoke success or CV scores alone do
not qualify. Delivery after the deadline does not qualify. Hand-over is terminal:
withheld labels join final training, tools end, and improvements require a
separate follow-up run. There is no intermediate delivery checkpoint.

The T3-prepared checkout and its fresh `runs/finetuned/solutions` are independent
of main. The local controller under `runs/finetuned/control/` records the start,
deadline, controller/task PID and group, observed process birth identities,
invocation/run IDs, delivery timestamps/checksums, exit status and final outcome.
It sends graceful cancellation to the task group and observed descendants at
600 seconds, allows bounded cleanup, then terminates remaining identified run
processes. Records and completed trial/refit evidence remain in place.

Local prerequisites use private snapshots of the pinned toolchain, Python
interpreter/packages and JS dependencies in `/dev/shm/t3-58044980`, linked into
this checkout to avoid the nearly full disk. The `.venv` itself is a real project
directory; its libraries link to that private snapshot. Editable smartlab-eval
is rebound to this checkout using locked uv sync. These RAM-backed snapshots
are lost on reboot and must remain available until the run and inspection end.
The copied `.env` remains ignored and is never included in launch hashes.
Course PDFs/text are regular-file copies with the tracked checksummed manifest.
Task state `runs/finetuned/spam1` and test temporary files also use this private
RAM-backed area: the unchanged preparation check requires at least 1 GB free,
which the host disk cannot currently provide. Other run records and delivery
files remain in this checkout. The individual `units/01-spam` source is linked from canonical data; that shared
source must remain read-only and unchanged during the run. System Nix store
executables/libraries are shared immutable dependencies. No prior solution,
minimal-arm code/artifact, or canonical run state is reused.

Launch metadata pins the commit and tracked file hashes, configurations, prompt
snapshot fingerprint/template hashes, local driver/controller, resource bytes
and dependency snapshot inventories. Harness prompt/rendered-message identity,
telemetry, promotion, validation, setup and sandbox checks are unchanged.

Verification and launch evidence are retained locally in
`runs/finetuned/control/`. The full integration suite is required before merge;
this experiment is not merged and does not wait for that suite before launch.

Validation commands:

- `./dev bun test harness/finetuned/agent/prompts harness/finetuned/agent/run/lead_session.test.ts harness/finetuned/agent/run/session_resources.test.ts harness/finetuned/agent/team/runner.test.ts`: 25 passed.
- `./dev bun test harness/finetuned/agent/run/research_sandbox.test.ts`: 3 passed.
- `./dev bun run typecheck`: passed.
- `./dev bun run pipeline -- spam1 --no-fetch --check-setup`: passed production prerequisites, including bounded remote probes; no stages executed.
- `./dev env TMPDIR=/dev/shm/t3-58044980/test-tmp bun run test:fast`: 539 passed, 2 skipped, 0 failed (541 tests, 72 files); private RAM-backed temporary files satisfy the unchanged free-space check.

Earlier local prerequisite failures and disk-space failures are retained in the
local logs. They are not successful tests or task attempts. No fresh task agent
is launched until verification and production preflight complete.

## Measured outcome, 2026-11-12

**No validated submittable delivery existed by the 600-second deadline.**
One fresh offline run was executed; it was not restarted or extended.

- Experiment commit: `6ca11d3667f9e9e50809eec4510001da972e955a`.
- Pipeline run: `904bdabb-6fb7-4fa7-af35-7c507d8db637`.
- Lead/training invocation: `3e8e269c-62a6-49c7-97f7-d57cae396222`.
- Task launch: 07:46:47.031 UTC. Deadline: 07:56:47.031 UTC.
- First harness trial started 07:51:08.656 and completed 07:51:17.174,
  balanced accuracy 0.50. The candidate treated the input dictionary's string
  representation as text rather than decoding the email bytes, according to
  the recorded solution commit's diagnosis.
- A repaired revision started its trial 07:52:47.773 and completed
  07:53:32.684, balanced accuracy 0.9902427936. These are harness development
  scores, not official task scores. No numerical quality target was supplied
  to the lead as part of this prompt experiment.
- The lead used 41/80 calls and made one explicit scout call. Validation
  journaled a finding that the repaired trial's frozen snapshot was not
  materialized at the stated source root and requested rematerialization and
  revalidation. This is a reported snapshot/access problem, not proof of a
  modelling defect. Its precise cause was not established by this experiment;
  post-cancellation filesystem inspection cannot prove the earlier scout view.
- No accepted handover, terminal refit or delivery files were recorded.
  PROGRESS remained `running`; the authoritative controller and pipeline
  outcome are cancelled, so that stale progress status is not a live run.
- SIGINT was sent at 07:56:47.043 UTC, about 12 ms after the deadline.
  Pipeline result was `cancelled` at 07:56:48.598. The task process remained
  alive after cancellation; bounded cleanup escalated to SIGTERM after ten
  seconds and SIGKILL after another five seconds. The controller finished at
  07:57:02.347, elapsed 615.316 seconds including cleanup, with no tracked
  descendants remaining. Parent confirmed controller/task PIDs were gone.

Parent audit before this documentation update found zero changed pinned
tracked files against launch metadata. Runtime configuration remained offline
MythLLM `qwen3.8-flash-next-a5b`. Fresh independent task state and private
dependency snapshots were used; original finetuned/minimal evidence remains
untouched. Main development continued separately. No merge, push or upload.

Evidence remains under `runs/finetuned/control/`: `launch-metadata.json`,
`guidance.json`, `status.json`, `pipeline-result.json`, task/controller logs
and test logs. Trial/PROGRESS/findings records remain in the private task
state linked under this checkout. RAM-backed evidence is lost on reboot;
this tracked report preserves the measured outcome and its limitations.

The experiment tested earlier delivery priority and reached repair/validation
within ten minutes, but did not establish that prompt changes alone produce
an early submittable result. It does not test continuing optimization after
an intermediate delivery: current handover remains terminal. No second run
or infrastructure fix was undertaken as part of this bounded experiment.
