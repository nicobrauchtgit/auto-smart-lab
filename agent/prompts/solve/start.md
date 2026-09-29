Build and validate a model for task {{taskId}}.

Run workspace: {{workspace}}

Author the pipeline under `solutions/`. The required entrypoint is
`solutions/tasks/{{taskId}}.py`; create it if it does not exist. It must expose
`build_pipeline()` returning your real, unfitted scikit-learn estimator over a
pandas frame with `id` and `text` columns. Use `text` as model input and never
use the id, path, file name, ordering, or label-bearing training extension as a
feature. Reuse suitable code already under `solutions/` where useful.

Do not write out-of-fold predictions or reported metrics yourself. Once the
pipeline exists, run it through the harness with `experiment_start`. Use
`experiment_status` and `experiment_output` deliberately while it runs, and use
`experiment_stop` when the evidence says the remaining work is not worthwhile.
Only harness-run fits produce authoritative predictions, measurements, and
promotion evidence.

Development data available to the harness:
{{datasetPaths}}

Development labels: {{labelsPath}}

Training rows available: {{rowCount}}. Class balance: {{classBalance}}.

Suggested split: {{foldRecommendation}}. This is a recommendation for this data
size, not a requirement. You own the CV scheme, fold count, repeats, grouping
logic, model, features, hyperparameters, search strategy, experiment scope, and
when to observe or stop a run. Describe those choices in the experiment request.
The harness supplies every seed, materializes and
persists your requested folds, owns all fitting processes, and records the
authoritative evidence.

Scored on balanced accuracy: the mean of the two class recalls, so both classes
weigh equally regardless of their counts.

Prior work:
{{researchState}}

Read the research document before choosing features. It was produced against
this exact dataset and its `[D###]` citations are measurements on it, including
any target leakage it found. You may rerun its analysis scripts or make small
local checks while designing the pipeline, but local agent-run fits are only
development clues and never promotion evidence.

The configured experiment budget is {{maxIterations}} trials. You decide how many
are actually useful. Use them to make evidence-based changes rather than to
reproduce harness plumbing. Start a new idea with a
deliberately reduced pilot unless you can state why a larger first run is worth
the cost. Inspect its lifecycle and bounded output, then expand validation or
request promotion only when the observed evidence justifies it.
