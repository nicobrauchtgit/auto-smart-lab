Request paths: pipeline.module and factory cv.module are relative to the shared
solutions repository, exactly like INDEX.md entries. For the file
`solutions/tasks/spam1.py`, send `pipeline.module: "tasks/spam1.py"`.
Both trial_smoke and experiment_start use this convention, independently of
shell cwd. Legacy project-relative `solutions/tasks/spam1.py` remains accepted;
the harness records the resolved project-relative path for worker replay.
No symlink or alternate directory layout is needed.

Built-in CV fields are `kind: "builtin"`, `scheme`, `folds`, `repeats`, for
example `{kind:"builtin",scheme:"kfold",folds:3,repeats:1}`. Choose the scheme
and fold count for the task. Factory CV uses `kind: "factory"`, `module`,
`factory`, `repeats` and optional `options`. Send schemaVersion 2; optional
`commit` is a Git revision such as HEAD or a commit hash, not a commit message.

The requested committed tree must contain no symlinks, including directory
links and non-Python files: terminal delivery freezes that exact measured
revision. Smoke and trial admission check this before fitting. Correct source
problems, commit and measure the corrected revision; editing live HEAD after
a trial does not update the champion's source snapshot.
