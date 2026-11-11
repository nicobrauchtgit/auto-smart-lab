# Solutions

Model code written by the solve stage's agent. It persists across tasks, units,
and runs so later work can import earlier work.

One convention: `solutions/tasks/<task_id>.py` is the orchestration entrypoint
for a task. It defines a factory — `build_pipeline()` unless `metrics.json` says
otherwise — returning an **unfitted** estimator with `fit(X, y)` and `predict(X)`,
where `X` is a pandas DataFrame with `id` and `input` columns. Each `input` names
a zip archive and member; the pipeline reads and represents the raw bytes itself.

That convention exists so the harness can re-run the pipeline for its own fits
and the paired champion comparison. It is not a design constraint:
everything else here is the agent's to organise, and shared modules can live
wherever it finds useful.

Search INDEX.md and existing modules before writing code. Record module paths,
purpose, owner role and importing tasks in INDEX.md. Python belongs in tasks/,
lib/ or checks/. Each module starts with a two-line purpose/input-output
docstring. Move shared code into lib/ when a second task imports it. Keep large
or temporary output in ignored scratch/. Run workspace_check before trials.
