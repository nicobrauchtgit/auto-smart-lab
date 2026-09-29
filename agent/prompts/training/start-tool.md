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
