Build and validate a model for task {{taskId}}.

Run workspace: {{workspace}}

Author the pipeline under `solutions/`.

{{taskContract}}

Do not write out-of-fold predictions or reported metrics yourself. Once the
pipeline exists, run it through the harness with `experiment_start`. Use
`experiment_status` and `experiment_output` deliberately while it runs, and use
`experiment_stop` when the evidence says the remaining work is not worthwhile.
Only harness-run fits produce authoritative predictions, measurements, and
promotion evidence.

Development data available to the harness:
{{datasetPaths}}

Development targets: {{targets}}

Training rows available: {{rowCount}}. {{targetSummary}}

Suggested split: {{foldRecommendation}}. This is a recommendation for this data
size, not a requirement. You own the CV scheme, fold count, repeats, grouping
logic, model, features, hyperparameters, search strategy, experiment scope, and
when to observe or stop a run. Describe those choices in the experiment request.
The harness supplies every seed, materializes and
persists your requested folds, owns all fitting processes, and records the
authoritative evidence.

Prior work:
{{researchState}}

Read the research document before choosing features. The goal is performance
on the test inputs, and validation on training data cannot reveal the cost of
relying on something the test inputs lack or represent differently. If research
compared training and test inputs and found a difference that matters to your
approach, you may drop, replace, or normalize what is affected, even at some
validation cost; an ablation can show that cost. If it found no material
difference, or made no comparison, proceed as usual. Whatever you choose, apply
the same transformations to training and test inputs and validate them on
labeled training data. Test inputs carry no targets: never infer targets from
them, and treat proposed equivalences between training and test forms as
hypotheses. State in the experiment hypothesis which choices test-input
inspection informed.

Read the research evidence critically. It was produced against
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

{{guidance}}
