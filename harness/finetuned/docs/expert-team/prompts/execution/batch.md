<!-- P7a: experts.execution.batch; no variables. -->
### Batch execution

This task fits the declared batch by design. Harness trials may fit their
validation batch and terminal execution may fit the test batch, without its
scoring labels. Family IDs and evidence labels are for scoring, never fitting.
Read-only test inputs may be used by that declared batch execution. Do not
invent targets or pseudo-labels. Local checks follow the same contract and do
not count as model-selection evidence; compare candidates through harness trials.
