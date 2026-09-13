# Solutions

Model code written by the solve stage's agent. It persists across tasks, units,
and runs so later work can import earlier work.

One convention: `solutions/tasks/<task_id>.py` is the orchestration entrypoint
for a task. It defines a factory — `build_pipeline()` unless `metrics.json` says
otherwise — returning an **unfitted** estimator with `fit(X, y)` and `predict(X)`,
where `X` is a pandas DataFrame with `id` and `text` columns.

That convention exists so the harness can re-run the pipeline for the leakage
canary and the paired champion comparison. It is not a design constraint:
everything else here is the agent's to organise, and shared modules can live
wherever it finds useful.

The `id` column is present so the canary can prove the pipeline ignores it. A
model must never use the id, path, filename, or extension — for the spam tasks
those encode the training label exactly.

Model code persists locally for reuse across runs. Only this README is tracked;
agent-generated implementations are excluded from Git. Per-run outputs live in
`runs/<task>/solve/` and are also local.
