Build and train a model for task {{taskId}}.

Run workspace: {{workspace}}
Write `metrics.json`, `oof_predictions.csv`, and `notes.md` there. Your code goes under `solutions/`. The entrypoint
`solutions/tasks/{{taskId}}.py` already exists with a working baseline in it;
edit that rather than starting from nothing.

Data, unmodified:
{{datasetPaths}}

Labels: {{labelsPath}} — pass this path to `load_labelled()`; do not open it, it
is thousands of lines. It covers every row in your training archive. A further
stratified portion of the original data is held out of that archive entirely;
the harness scores it against your declared factory and shows you the result at
the end.

Training rows available: {{rowCount}}. Class balance: {{classBalance}}.

Suggested split: {{foldRecommendation}}. This is a recommendation for this data
size, not a requirement. Use a different scheme if you have reason to, and
record what you used in `metrics.json`.

Scored on balanced accuracy: the mean of the two class recalls, so both classes
weigh equally regardless of their counts.

Prior work:
{{researchState}}

Read the research document before choosing features. It was produced against
this exact dataset and its `[D###]` citations are measurements on it, including
any target leakage it found. You do not need to re-measure what it already
establishes, but you may rerun its analysis scripts if you want to check
something.

You have {{maxIterations}} iterations. After each one you will be shown measured
results for it.

Working practice that matters here:

- **Finish a complete result in iteration 1**, even a plain one. Nothing is
  measured, and no champion exists, until the three output files are written. A
  strong model that never wrote `metrics.json` scores nothing.
- **Watch the clock.** One cross-validation pass over this corpus takes on the
  order of a minute per fold with a sparse linear model. An exhaustive grid
  search will exhaust your iteration instead. Prefer a few deliberate variants
  over a large sweep, and report how many you compared.
- **Use `smartlab_eval` to load the data and write the results.**
  `load_labelled(zip, labels)` returns the whole corpus as an aligned
  `(frame, y)` in about 0.25 s, with ids in the exact form every other file
  uses; `Results` accumulates folds and writes the contract. Rolling your own
  archive loop is the one mistake that reliably costs the whole session.
- **Ids are full archive paths**, like `data/spam1-train/ubqnocmfmxdywlax.0`.
  Pass them through unchanged. A file name in place of a path matches no labels
  row and makes the results unmeasurable.
- **Seed everything.** Unseeded models cannot be compared across iterations and
  fail the reproducibility check.
