# Model evaluation

The registered `evaluate` stage follows solve and performs one short review of
its selected harness trial. It produces an advisory **submission readiness
score from 0 to 5**, an assessment, evidence-linked concerns, limitations, and
up to three suggested improvements. The score is an ordinal review judgment,
not a predicted platform metric. Critical/high/medium concerns cap the score
at 1/2/3 respectively; unavailable implementation limits it to 3.

The goal and scoring rubric live in `agent/prompts/review/`. The review guide
is explicitly injected as a versioned skill; no repository development
instructions or automatic skill loading are needed. Legacy `evaluation.*`
prompts remain separate for the old orchestrator.

The controller revalidates the selected trial and upstream hashes, then derives
accuracy, balanced accuracy, macro F1, class precision/recall/support, confusion
matrices, fold spread, and binary ROC AUC / average precision from saved OOF
predictions and the invocation's **development labels**. No model is imported,
no fitting occurs, and no sealed labels or test predictions are supplied.
ROC and PR curves are retained in JSON and in a standalone `curves.svg` when
scores exist. Missing scores are explicit; decision margins are supported,
but no calibration claim is made without score provenance.

The reviewer receives compact metrics, candidate/CV configuration, limitations,
and the candidate entrypoint. Its only tools are:

- `evaluation_detail`: inspect saved curves, fold results, or candidate configuration.
- `evaluation_code`: read Python implementation/helpers under `solutions/`, with
  traversal and symlink checks. Exact reviewed files are snapshotted and hashed.
- `evaluation_report`: record one schema-validated review and readiness rationale.

The prompt gives the reviewer a budget of **15 turns** and asks it to finish
earlier when possible. This is advisory: no evaluator turn counter, inspection
call cap, or stage-specific deadline enforces it. There is one session attempt;
the shared runner retains its general session timeout and cancellation support.
A session failure or absent/invalid report
fails the stage, never defaults to approval. A valid report with concerns is a
successful evaluation, not a successful model or permission to submit.

Artifacts live in `<selected-trial>/evaluation/<invocation-id>/`: `evidence.json`,
`review.json`, optional `curves.svg`, and reviewed source snapshots. They retain
source hashes and experiment identity. The shared executor owns lifecycle,
preflight, stage results and session observations. Preflight checks model access,
the shared Python environment and diagnostic imports for the entire requested
chain before agents start. No new Python dependencies are required.

Standalone use follows the same executor:

```sh
bun agent/evaluate_cli.ts spam1 --training-root runs/spam1/solve/training/<run-id>
bun agent/evaluate_cli.ts spam1 --training-root <training-root> --check-setup
```

The training-root argument must contain the actual harness experiment directories.
The current selection rule is highest development balanced accuracy among valid
eligible trials. The evaluator reports selection optimism; it does not introduce
a new model-selection rule. Fold spread is not a confidence interval, repeated
OOF rows are correlated, and pooled curves can combine different score scales.
No demographic fairness conclusion is possible without suitable group data.
Code review can flag leakage and inappropriate splits but does not execute a
leakage canary. Source is captured at review time: the current training artifacts
do not prove the reviewed bytes are exactly those fitted. This limitation is
explicit in the source tool and must be disclosed in the review.
