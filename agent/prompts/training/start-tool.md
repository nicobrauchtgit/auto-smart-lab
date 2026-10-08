Start a harness-owned training experiment and receive its ID immediately.

You choose the pipeline, parameters, cross-validation design, hypothesis, and
scope. The harness supplies all seeds, materializes the fold assignments, owns
every fit, and writes the authoritative predictions and metrics. Do not include
a seed in the request.

Optional schemaVersion 2 diagnostics request the measurements you need:
representation: {source:"pipeline_features", metric:"euclidean", maxRows:512,
dbcv:true}, or {source:"method", method:"diagnostic_features"} for a custom
fitted estimator. Feature methods return row-aligned numeric matrices without
fitting. Geometry is measured in that declared space and sampled with harness
randomness. Noise coverage accompanies internal scores. predictionStrength:true
requests one additional harness fit on validation inputs for inductive
clustering, comparing independent validation clusters with train-model
predictions; no targets enter either unsupervised fit.

Label-free searches require an explicit advisory search.objective:
{kind:"proxy", metric:"silhouette", direction:"maximize"}. Other metrics are
calinskiHarabasz, daviesBouldin, dbcv, or estimator_score. Geometry objectives
require representation diagnostics; dbcv requires dbcv:true. estimator_score
calls the fitted estimator's score() on validation inputs. Lower-is-better
objectives use direction:"minimize". Proxy selection is distinct from the
controller primary metric and cannot promote label-free candidates. Fixed
follow-up requests preserve diagnostics; inspect their evidence before choosing
the next experiment.

Start a new idea with `scope.kind: "pilot"` and deliberately reduced work, such
as `maxRows` or `maxFolds`. A pilot validates assumptions and estimates cost but
cannot promote a model. Use `scope.kind: "promotion"` only when the preceding
evidence justifies complete validation.

A built-in CV request supports stratified_kfold, kfold, or group_kfold (whole
families/groups held out, when supplied by the task). A factory CV request points to
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

Read experiment_status after fixed trials to inspect the recorded quality
diagnostics before designing the next experiment. Per-fold spread is not a
confidence interval. The paired interval uses the existing approximate fold
noise rule, whose independence assumption is imperfect because training rows
overlap. Advisory threshold optima were selected on validation rows and do not
change the pipeline's threshold automatically.

A measured cost above the harness threshold stops gracefully with retained
work. Decide whether the cost is justified and set search.acceptEstimatedSeconds
to cover the reported projection in a subsequent request; reducing configs or
pilot scope is also possible. The harness checks drift and its hard time cap
at fold/configuration boundaries. An opaque in-progress fit can finish beyond
the cap; experiment_stop remains available. SchemaVersion 1 single requests
remain supported.
