# Architecture and flow

[Work queue](cleanup-plan.md) · [Decisions](adr/README.md) · [Source inventory](code-inventory.md)

All **CURRENT** diagrams describe the code that runs today, including P3 run
mechanics. The accepted v2 design
([expert-team-v2.md](../harness/finetuned/docs/expert-team-v2.md)) is not
implemented; its run shape is at the end of this page. The
[generated inventory](code-inventory.md) identifies the measured source bytes.
Dashed links describe access or feedback, not automatic stage
succession. Stage names are capabilities selected by the controller; arrows
give a common local route, not a mandatory fixed workflow.

## Module boundaries and review map

| Boundary | Owns | Key source / contract |
| --- | --- | --- |
| Experiment host | Arm dispatch, shared configuration, run preparation | [cli.ts](../experiment/cli.ts), [config.ts](../experiment/config.ts), [minimal.ts](../experiment/minimal.ts) |
| Pipeline executor | Stage lifecycle, typed artifacts, validation, preflight | [executor.ts](../harness/finetuned/agent/pipeline/executor.ts), [types.ts](../harness/finetuned/agent/pipeline/types.ts), [setup.ts](../harness/finetuned/agent/pipeline/setup.ts) |
| Research inputs | Deterministic dataset profile, task context, course resources (for v2's scouts) | [profile.ts](../harness/finetuned/agent/research/profile.ts), [research README](../harness/finetuned/agent/research/README.md) |
| Solve / training | Agent trial requests versus harness execution and promotion | [solve session](../harness/finetuned/agent/run/harness_solve_session.ts), [training README](../harness/finetuned/agent/training/README.md) |
| Confirmation | Hidden independent check on the sealed rows | [confirmation service](../harness/finetuned/agent/confirmation/service.ts) |
| Refit / submit | Terminal full-data predictions versus separately authorized upload | [refit service](../harness/finetuned/agent/refit/service.ts), [submit stage](../harness/finetuned/agent/pipeline/stages/submit.ts) |
| Session / context | Physical sessions, explicit prompts, logical hand-offs | [session runner](../harness/finetuned/agent/run/session_runner.ts), [context README](../harness/finetuned/agent/context/README.md) |
| Telemetry | Shared run/invocation observations; does not replace recovery state | [telemetry contract](../harness/finetuned/docs/telemetry.md) |

## CURRENT experiment dispatch and isolation

```mermaid
flowchart TD
    CLI[experiment/cli.ts: parseExperimentArgs] --> CFG[experiment.config.json: shared model and online mode]
    CFG --> ARM{arm}
    ARM -->|minimal| MIN[experiment/minimal.ts: prepareMinimalRun and runMinimal]
    ARM -->|finetuned| FIN[pipeline_cli.ts then executor.runPipeline]
    MIN --> MJ[Whole arm process in bubblewrap]
    MJ --> MR[runs/minimal/stamp: copied agent and own venv]
    FIN --> FJ[Solve file tools in bubblewrap]
    FJ --> FR[runs/finetuned: per-task state and solutions]
    U[Allowed task material from units, excluding private underscore dirs] -. read only .-> MJ
    U -. selected mounts .-> FJ
    X[Other arm code/state and repository secrets] -. excluded mounts .-> MJ
    X -. excluded mounts .-> FJ
```

Evidence: [parseExperimentArgs / dispatch](../experiment/cli.ts), [minimal adapter](../experiment/minimal.ts), [prepareSolveSandbox](../harness/finetuned/agent/run/solve_sandbox.ts), [finetuned boundary tests](../harness/finetuned/agent/run/arm_boundary.test.ts), [minimal boundary tests](../experiment/minimal.test.ts). This is a tool/process boundary; trusted harness code runs outside agent jails.

## CURRENT minimal flow

```mermaid
flowchart TD
    B[solve_units.ts: sequential task batch] --> O[orchestrate.ts: task budgets and facts]
    O --> S[solver_session.ts: one solver agent]
    S --> A[Agent owns code, fits and visible labels]
    A --> D{SOLVER_DONE and mechanical output check}
    D -->|invalid or unfinished, within limits| S
    D -->|valid offline| H[deliver.ts: output, source archive, manifest]
    D -->|valid online and attempts available| U[submit_session.ts: deterministic upload]
    U --> R{Score and remaining attempts}
    R -->|continue| S
    R -->|done| E[Task ends, batch continues]
    H --> E
```

Source: [batch](../harness/minimal/agent/run/solve_units.ts), [task loop](../harness/minimal/agent/run/orchestrate.ts), [session](../harness/minimal/agent/run/solver_session.ts), [checkCsv / checkToken](../harness/minimal/agent/run/output_check.ts), [delivery](../harness/minimal/agent/run/deliver.ts). Finetuned promotion rules do not apply to this arm. The mechanical check is not a statistical quality assessment.

## CURRENT finetuned stages and trials

The orchestrator, research and evaluate stages and the knowledge store were
removed on 2026-11-11. The remaining configured chain:

```mermaid
flowchart TD
    P[pipeline_cli.ts] --> E[executor.runPipeline: configured chain]
    E --> I[executor.invokeStage: lifecycle and validation]
    I --> S[solve: agent designs pipeline and requests trials]
    I --> F[refit: freeze champion and fit all labelled rows]
    I --> U[submit: explicit controller policy only]
    S --> T[TrainingService: source snapshot, seeds, persisted folds]
    T --> W[Python worker: fits, OOF predictions and measurements]
    W --> G{Eligible completed promotion evidence}
    G --> CH[Champion tag and selected evidence]
    CH --> CF[Binary sealed confirmation after the session]
    CH -. frozen identity .-> F
    F --> H[Validated prediction artifact and offline delivery]
```

[Registry.getStage](../harness/finetuned/agent/pipeline/registry.ts) is authoritative. [startStageInvocation / invokeStage / runPipeline](../harness/finetuned/agent/pipeline/executor.ts) own lifecycle and validation, with [setup](../harness/finetuned/agent/pipeline/setup.ts) before sessions. A finished session does not establish artifact validity.

[TrainingService](../harness/finetuned/agent/training/service.ts), [worker](../harness/finetuned/agent/training/python/worker.py), [search implementation](../harness/finetuned/agent/training/python/smartlab_trial/search.py) and [pairedPromotion](../harness/finetuned/agent/training/promotion.ts) own evidence. When no champion exists, initialization selects the best eligible open trial. To replace an existing champion, the paired lead must be positive and exceed two standard errors on identical persisted folds; a standalone score or advisory readiness is insufficient. See [runConfirmation](../harness/finetuned/agent/confirmation/service.ts), [terminal refit](../harness/finetuned/agent/refit/service.ts) and [delivery](../harness/finetuned/agent/refit/delivery.py).

Configured chains never automatically reach submit, even if available. Follow-up solves branch from the champion through [branches.ts](../harness/finetuned/agent/training/branches.ts); v2 additionally specifies merging successful follow-ups into the base.

## CURRENT source, evidence and sealed-data boundaries

```mermaid
flowchart LR
    RAW[Trusted original archives and labels] --> SPLIT[solve/workspace.ts: development and sealed split]
    SPLIT --> DEV[Development inputs visible to solve]
    SPLIT --> SEALED[Sealed rows and labels: harness only]
    DEV --> CODE[Agent pipeline in versioned solutions]
    CODE --> SNAP[Trial immutable source snapshot]
    SNAP --> FIT[Harness worker with persisted fold manifest]
    FIT --> EVID[Authoritative OOF, metrics, hashes, champion]
    SEALED --> CONF[Confirmation worker on frozen champion]
    EVID --> CONF
    CONF --> CTRL[Solve stage summary and refit check]
    EVID --> FREEZE[Terminal freeze binds source, params, dependencies and evidence]
    FREEZE --> REFIT[Harness full-data refit]
    RAW --> REFIT
    REFIT --> OUT[Test predictions and hand-over manifest]
```

[prepareSolveWorkspace](../harness/finetuned/agent/solve/workspace.ts) and [folds](../harness/finetuned/agent/solve/folds.ts) prepare split data; [terminal identity](../harness/finetuned/agent/training/terminal.ts) and [confirmation receipts](../harness/finetuned/agent/confirmation/receipt.ts) bind evidence. Sealed data enters training only after terminal freeze; it cannot then be independent confirmation. Current repeated split preparation is not the planned durable task-level configuration guard. Executing validation checks against the trial snapshot is a P6/P7 requirement. Non-binary confirmation currently skips. There is no automatic scrubber that removes sealed numbers from controller-authored guidance.

Prompts are selected explicitly via [registry](../harness/finetuned/agent/prompts/registry.ts) and [loader](../harness/finetuned/agent/prompts/loader.ts), snapshotted with content/message hashes. [runSession](../harness/finetuned/agent/run/session_runner.ts) disables ambient context files. Prompt provenance, typed input metadata, measured trial evidence and Langfuse traces answer different review questions; none replaces the others.

## CURRENT process and resource ownership

```mermaid
flowchart TD
    HOST[Host harness process outside agent tool jail] --> SESSION[Pi physical session and context hand-off]
    HOST --> SERVICE[TrainingService: durable worker ownership and recovery]
    SERVICE --> SUP[ExperimentSupervisor: process group, output and samples]
    SUP --> RUNNER[Python runner and worker]
    RUNNER --> CHILD[Estimator and joblib descendants]
    SESSION --> TOOL[Sandbox file and shell tools]
    TOOL --> SCRIPT[Agent investigative script]
    SAMPLE[Darwin libproc sampler; Linux returns no samples] -. samples .-> SUP
    LF[Langfuse lifecycle/session telemetry] -. observes .-> HOST
    DISK[Authoritative run receipts, source and predictions] -. recovery .-> SERVICE
```

[Supervisor](../harness/finetuned/agent/experiments/supervisor.ts), [ownership](../harness/finetuned/agent/experiments/ownership.ts), [sampler](../harness/finetuned/agent/experiments/sampler.ts), [runner](../harness/finetuned/agent/training/python/runner.py). The generic supervisor is used by harness workers; its opt-in tools are not a universal observer of current agent shell commands. Research still has a bash timeout. The sampler returns no samples on Linux, so CPU/RSS-based stall and memory signals do not work on this host today. There is no shared RAM pool and no machine-protection stop yet; v2 section 6 plans one with its own sampler, because the deferred P1 investigation showed kernel OOM ordering cannot be controlled without privileges ([ADR 003](adr/003-finite-ram-observation.md)). Context-token hand-offs are separate from process RAM.

## ACCEPTED v2 DESIGN, NOT IMPLEMENTED: lead agent and scouts

```mermaid
flowchart TD
    H[Harness: prepare task data and persistent split once per task] --> L[Lead agent: drives the run, budget in tool calls]
    L -->|blocking call, focused question| S{Scouts}
    S --> SD[Data scout]
    S --> SI[Ideas scout: read-only, web search]
    S --> SV[Validation scout: checks on trial snapshot]
    SD -. bullets with sources .-> L
    SI -. bullets with sources .-> L
    SV -. ok / fix / advice .-> L
    S -. bullets .-> J[Findings journal]
    L --> WS[Shared solutions tree]
    L --> SM[trial_smoke: cheap checks, no trial charged]
    SM --> T[Harness trial on shared folds]
    T -. folds, noise verdict, Ladder holdout verdict .-> L
    SUP[Global supervision: wake on news, machine-protection stop] -. observes .-> T
    SUP -. observes agent shell calls .-> L
    L -->|hand_over| HV[Validation scout once on champion snapshot]
    HV --> RF[Terminal refit including withheld rows]
    B[Budget end without hand-over] --> RF
```

This is [expert-team-v2.md](../harness/finetuned/docs/expert-team-v2.md) sections 2–6, **not current runtime**. There is no LLM orchestrator and no fixed stage order; the lead decides when to call scouts, start trials and hand over. Labels of withheld rows are never shown; on a new champion the lead hears only a rounded Ladder verdict. P6 foundations come first, then P7a (lead and scouts) and P7b (harness services), then the integration gate and P7c. Contracts kept from the first design are in [expert-team.md](../harness/finetuned/docs/expert-team.md). [ADR 007](adr/007-lead-and-scouts.md) records the decision.
