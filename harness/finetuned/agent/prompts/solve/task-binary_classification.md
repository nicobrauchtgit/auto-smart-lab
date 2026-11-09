This task is binary classification. The required entrypoint is
`solutions/tasks/{{taskId}}.py`; create it if it does not exist. It must expose
`build_pipeline()` returning your real, unfitted scikit-learn estimator over a
pandas frame with `id` and `input` columns. Each `input` is an object
`{"archive": <absolute path of a zip archive>, "member": <member name>}`; your
code reads the raw sample bytes from that archive member and decides how to
represent them. The harness never decodes or parses samples for you. Never use
the id, member name, ordering, or a label-bearing file extension as a feature.
Reuse suitable code already under `solutions/` where useful.

The harness fits on training folds with the binary targets and calls `predict`
on the validation rows; predictions must be 0 or 1.

Scored on balanced accuracy: the mean of the two class recalls, so both classes
weigh equally regardless of their counts.
