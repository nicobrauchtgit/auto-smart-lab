# Research: training discoveries and test-input applicability

Research explicitly inspects **labeled training inputs first, then unlabeled
test inputs**. Both were already accessible through the research session's
filesystem/bash tools; the new workflow makes test inspection an expected part
of feature research, not a reason to discard unverified training discoveries.
There is no extra agent session or automatic injection of either corpus.

`context.json` contains `dataset.research_inputs` with separate `training`,
`training_labels`, and `test` archive/file references and hashes, paired from
the existing task label adapter. Paths are relative to the research workspace.
The stage records these supplied inputs separately in observability. Shared
preflight already checks the paired archives, labels, Python environment and
service access before research starts, including standalone research commands.
No new tool, credential, Python package or model provider is introduced.

The versioned `research.test-distribution` prompt is deliberately task-neutral.
It asks the agent to:

1. Identify the input properties its findings rely on, recording how each was
   measured.
2. Release the training data, inspect the test inputs in a second pass, and
   apply the same measurements. Keep only summaries in context.
3. Compare the splits with size-independent measures and honest sample scopes.
4. State whether each main recommendation carries over, needs adapting, or
   should be deprioritized, and check any proposed alternative in both splits.

The pass scales to the task: when the splits look alike in the respects that
matter, a short confirmation suffices. For a text task, for example, a word
tied to one class may be missing from the test inputs while a formatting
pattern remains; research can propose the pattern, and training validation
must still show that it helps. Similar inputs never prove that a learned
relationship transfers. Task-specific refinement of this guidance is planned
for the orchestrator; see [the architecture plan](../../docs/orchestrator-architecture-plan.md).

The researcher owns reproducible scripts under `analysis/`; it can adapt the
analysis to the task instead of being limited to prescribed feature extractors.
Each cited JSON evidence record uses `split: "training"` or `split: "test"`
alongside `scope`, `population`, `method` and `values`. Artifacts identify the
current dataset snapshot. When a test archive is available, artifact validation
requires cited records for both populations. This verifies evidence presence
and structure, not the truth of every prose inference or execution of scripts.

Keep the established report sections. Include a compact feature comparison in
Evidence-backed findings / Guidance for the solver, and disclose test-informed
choices and remaining uncertainty in Risks and unknowns. Solve is explicitly
instructed to use this research while evaluating feature benefit on labeled
development folds. The supervised model is trained on training data and applied
to test data. Any proposed unsupervised joint fitting is a separate, disclosed
experiment. Sealed confirmation labels and test performance are not supplied.

All authored instructions live in `agent/prompts/research/`; the new comparison
guide is registered, snapshotted once per run, and traced like the other prompts.
The existing no-development-context-loading policy remains unchanged. This
workflow controls instructions and evidence, not filesystem isolation.
