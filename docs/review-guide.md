# Review guide

This is the entry point for reviewing `merge-arms`. Runtime status: integration parent **83b2d47** (P3 merged in **fd96ccd**), inspected via Git objects on 2026-11-10. This documentation checkout and its generated metrics remain based on **6901a54** until parent integration. This documentation change adds no runtime behavior. The generated inventory identifies source bytes independently of the eventual documentation commit. Package statuses below must be refreshed after integration.

## Reading order

1. [Experiment](experiment.md): question, intended comparison, arm differences, reset and isolation.
2. [Architecture](architecture.md): current execution diagrams, evidence boundaries and source map.
3. [Code analysis](code-analysis.md) and [generated inventory](code-inventory.md): scope, counts and review hotspots.
4. [ADRs](adr/README.md): why responsibilities and resource limits are divided this way.
5. [Sole active queue](cleanup-plan.md), [redesign and status](redesign-plan.md), then [task coverage](tasks.md).
6. For implementation changes, read [integration](../harness/finetuned/docs/pipeline-integration.md), [training ownership](../harness/finetuned/docs/harness-owned-training.md), [telemetry](../harness/finetuned/docs/telemetry.md), [prompt loader](../harness/finetuned/agent/prompts/README.md) and the relevant module README. The [minimal README](../harness/minimal/README.md) explicitly marks pre-merge historical sections; use root commands here.

## Current integration-parent status

| Area | Implemented in parent | Pending or unestablished |
| --- | --- | --- |
| Dispatch | Two arms, shared configuration, separate run locations, bubblewrap boundaries | Measured comparative protocol, repetitions and memory carryover policy undecided |
| Finetuned runtime | Durable controller, shared executor, research/solve/advisory evaluate/deterministic refit and policy-controlled submit | Four expert stages and shared expert workspace are design only |
| Execution evidence | Harness trials, source snapshots, folds/seeds, promotion and binary confirmation | Clustering confirmation skipped; label-free diagnostics do not yet reach final refit |
| Resources | Owned process groups and supervisor transport; Darwin sampler | P1 Linux sampler, observed agent scripts and shared memory pool integration |
| Controller mechanics | P3 integrated: event/deadline waits, actual launched-trial charging, budget-end hand-over, detached progress and recovery fixes | Whole-branch validation and live shakedown remain |
| Diagnostics | P4 scorecard exists in parent | P3 hooks are integrated; memory measurements still depend on P1 and actual finished runs |

P3 is integrated at **fd96ccd**, with three review fixes and **61 focused tests passing** as reported in the parent's status table: terminal champion reconciliation, pre-spawn accounting, and recovered budget-end refits crossing the deadline. These local fixtures do not establish a successful live run. Its earlier implementation tip ad016a5 is historical, not the integration authority.

P1 is **pending and unintegrated**. Final investigation **eee1894** on `t3/protect-trials-under-pool-pressure` found no tested unprivileged controls that guarantee strict scripts-first/largest-script victim ordering. Its production pool setup/launch guard now refuses unconditionally. `oom_score_adj` alone is only a bias: an inverted-size reproduction killed a larger trial while a smaller script survived. The user decision is pending: defer P1, accept explicitly documented best effort, or retain strict blocking. This document selects none of those policies. Observed research/solve scripts and the shared pool are not current runtime.

## Setup and commands, traced to source

Run from repository root. [dev](../dev) bootstraps pinned mise; [mise.toml](../mise.toml) pins bun/uv/rg/fd and defines setup/test. Host prerequisites include git, zip/unzip, curl or wget; confinement needs Linux bubblewrap and usable namespaces. Shared Python is `harness/finetuned/.venv`, exposed as `VENV_DIR`. Do not create a second pipeline environment or use raw pip.

| Command | What it does / source |
| --- | --- |
| `./dev setup` | Managed Python and locked finetuned packages, then frozen JS install; mise setup task |
| `./dev mise run test` | Typecheck, Bun tests, then four Python unittest discovery suites; mise test task and [package.json](../package.json) |
| `./dev bun test experiment harness/finetuned/agent/run/research_sandbox.test.ts harness/finetuned/agent/run/solve_sandbox.test.ts` | Arm and agent confinement regressions |
| `./dev bun scripts/code-inventory.ts` | Regenerate tracked-source report; no run/model access |
| `./dev bun scripts/code-inventory.ts --check` | Fail if inventory differs from source bytes |
| `./dev bun run experiment -- --arm minimal --check-setup` | Minimal bounded local prerequisites; [dispatch](../experiment/cli.ts), [minimal adapter](../experiment/minimal.ts) |
| `./dev bun run experiment -- --arm finetuned --check-setup spam1` | Whole available chain preflight; may make a tiny explicit provider probe, never a solver session |
| `./dev bun run experiment -- --arm finetuned spam1` | Actual model pipeline, under shared online/offline policy; not a documentation validation command |
| `./dev bun run experiment -- --arm minimal --only spam1` | Actual minimal run; fresh run directory |
| `./dev bun run experiment -- --arm finetuned --reset` | Preview state deletion; `--yes` performs it, preserving deliveries |
| `./dev bun run scorecard -- spam1 --run <id>` | Read finished-run indicators; [scorecard README](../harness/finetuned/agent/scorecard/README.md) explains unavailable measurements |

At this baseline [experiment.config.json](../experiment.config.json) sets `online: false`, while [finetuned pipeline.config.json](../harness/finetuned/pipeline.config.json) enables `submit` as an available capability and uses agent scheduling. The offline controller policy prevents uploads. Older statements that the submit stage itself is disabled need reconciliation by the parent.

Standalone `research`, `solve-stage`, `evaluate-stage` and `refit-stage` scripts are in package.json and enter the shared executor/preflight. Availability is not upload permission: configured chains stop before submit. Offline mode fetches nothing and aims for one validated hand-over for manual delivery to the instructor. This task did not invoke model preflight, live pipelines or real uploads.

## Review evidence and known limits

Boundary tests establish specific mount/tool behavior, not universal network isolation or resistance to a hostile host. Minimal shell tools drop credentials but the model process key can still be exposed through parent `/proc` environment access; see the experiment contract. Disabling ambient AGENTS/CLAUDE loading is prompt hygiene, not filesystem isolation.

Only tasks both arms can execute belong in a comparison. Spam has the clearest existing path. `code2` has clustering support but a batch fit legitimately uses the unknown input batch: blanket “never fit test inputs” advice is incorrect. Some training APIs support metadata/batch semantics ahead of task-preparation/refit adapters. Inspect the execution declaration and [training contract](../harness/finetuned/docs/harness-owned-training.md), rather than inferring end-to-end support. `attacks1` is label-free and has no current hand-over path; P7c proposes unscored offline hand-over and independently checked evidence labels. Tor needs an unsupported multiclass kind. Reconstructed non-spam instructions and assumed output formats are limitations, not verified official contracts; see tasks.md.

Sealed confirmation currently supports binary tasks; other kinds are skipped. Current evaluation can see confirmation; the proposed validation expert cannot. Keeping sealed numbers out of controller guidance and knowledge is an instruction, with **no automatic sealed-guidance filter**. Historical exercise results in cleanup-history-2026-11-10.md (archived by the parent) predate this controller/redesign and do not prove a successful integrated shakedown. The active redesign records that orchestrated runs had not reached review/refit/hand-over when it was written. No new live evidence is claimed here.

Process RAM, model context tokens and cross-task knowledge are three distinct budgets (see ADRs). Endpoint capability probes do not prove whole-chain readiness. The study still needs choices for repetitions, sequencing/parallel arms, reset and cross-task learned memory before measured comparison.

## Parent refresh after integration

Regenerate code-inventory.md after staging all integrated sources. Refresh source metrics against the integrated P3 code. Update resource diagrams and ADR status only after any P1 policy decision and implementation are established. Keep the OOM ordering caveat until the inverted-size reproduction passes. Reconcile the package table above against the registry; P6/P7 must not appear as runtime solely because design docs landed. Parent owns cleanup-plan.md (sole active queue), cleanup-history-2026-11-10.md (historical evidence), redesign-plan.md (design/status) and existing P1/P3 module-doc reconciliation. Record actual test/live-scorecard results separately, preserving historical records and prompts.

## Documentation validation in this change

Validation below ran against this documentation checkout based on 6901a54, not the separately updated integration parent. `./dev setup` completed with the pinned toolchain and locked dependencies. `./dev bun run typecheck` passed, as did a separate compiler check of scripts/code-inventory.ts (the project tsconfig covers runtime directories, not scripts). Inventory generation, `--check`, category `--self-test` and repeated byte-identical regeneration passed. An offline navigation audit resolved all local Markdown targets and explicit anchors in the new/updated review documents; code fences are balanced.

The focused boundary/supervision selection (`./dev bun test experiment harness/finetuned/agent/run/research_sandbox.test.ts harness/finetuned/agent/run/solve_sandbox.test.ts`) passed **68 tests, 4 skipped, 0 failed**. Bun's substring filter also selects experiment-supervision and knowledge-experiment tests. Darwin sampling/live-watcher cases skip on this Linux host; they do not validate Linux sampling. No local Mermaid compiler (`mmdc` or installed Mermaid package) was available: the six committed diagrams were structurally inspected but not renderer-validated. No browser, server or dependency install was used to render them.

`./dev mise run test` passed type checking and progressed through the Bun suite, then hit the existing recovery test `restored original experiment budget cannot be increased by restart options` at its default 5-second timeout. A post-timeout metadata/setup error followed; the full run later stopped progressing and its owned Bun process required SIGKILL after SIGINT/TERM did not end it. The full suite is **incomplete and not passing** in this checkout. The isolated default-timeout case reproduced (1 failure, 1 error); the diagnostic rerun `./dev bun test harness/finetuned/agent/training/recovery.test.ts --test-name-pattern 'restored original experiment budget' --timeout 30000` passed in 7.3 seconds. This establishes timeout sensitivity, not its root cause. No test/runtime code was changed. Parent should resolve or explicitly account for it in final branch verification.

`./dev bun run test:py` then passed separately: **18 setup + 123 training + 9 evaluation + 5 research = 155 tests**. The script also passed `./dev bunx tsc --noEmit --ignoreConfig --moduleResolution bundler --module esnext --target es2022 --types bun --skipLibCheck --strict scripts/code-inventory.ts`. Final navigation checks resolved **201 local links/anchors across 12 review documents**, with balanced fences; the six Mermaid blocks passed basic flowchart/delimiter inspection, not renderer validation.
