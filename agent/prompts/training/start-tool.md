Start a harness-owned training experiment and receive its ID immediately.

You choose the pipeline, parameters, cross-validation design, hypothesis, and
scope. The harness supplies all seeds, materializes the fold assignments, owns
every fit, and writes the authoritative predictions and metrics. Do not include
a seed in the request.

Start a new idea with `scope.kind: "pilot"` and deliberately reduced work, such
as `maxRows` or `maxFolds`. A pilot validates assumptions and estimates cost but
cannot promote a model. Use `scope.kind: "promotion"` only when the preceding
evidence justifies complete validation.

A built-in CV request uses stratified K-fold. A factory CV request points to
your project-relative Python module and factory, allowing grouped, temporal, or
other custom splitting logic without changing the harness.

Use schemaVersion 2 for versioned experiments and search. `solutions/` is an
independent git repository. Commit all changes before starting; dirty staged,
unstaged, and untracked files are rejected with no budget consumed. `commit`
defaults to HEAD and may name an earlier commit. The harness runs a detached
worktree of that commit and records its hash, tree, branch and commit subject.

An optional `search` object specifies `space`, `sampler` (tpe, random, grid),
`maxConfigs`, and `pruning`. Plain names such as `model__C` target set_params;
`factory.features` values are merged into context["parameters"]. Distributions
are {type:"int",low,high,step?,log?}, {type:"float",low,high,log?}, or
{type:"categorical",choices:[JSON scalars]}. Grid accepts only finite int and
categorical spaces. TPE and random require maxConfigs. Fixed factory values go
in pipeline.parameters; fixed set_params values go in pipeline.estimatorParams.
Do not fix and search the same value. One search uses one experiment budget
unit, and every configuration shares one persisted fold manifest.

Read search-report.json after the run: leaderboard, parameter importance and
effects, paired differences, progress, cost, caveats, and the exact confirmation
request. A search is never promotion-eligible, including promotion scope.
Start the report's fixed-parameter confirmation request to validate the winner
on fresh folds. The champion is rerun from its frozen commit on those folds.
A challenger replaces the champion only when its paired lead on those folds
exceeds fold noise (more than 2 standard errors of the per-fold differences).

A measured cost above the harness threshold stops gracefully with retained
work. Decide whether the cost is justified and set search.acceptEstimatedSeconds
to cover the reported projection in a subsequent request; reducing configs or
pilot scope is also possible. The harness checks drift and its hard time cap
at fold/configuration boundaries. An opaque in-progress fit can finish beyond
the cap; experiment_stop remains available. SchemaVersion 1 single requests
remain supported.
