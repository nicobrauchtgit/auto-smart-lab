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
