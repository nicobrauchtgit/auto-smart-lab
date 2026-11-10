This task is anomaly detection without training targets. The required
entrypoint is `solutions/tasks/{{taskId}}.py`; create it if it does not exist.
It must expose `build_pipeline()` returning your real, unfitted scikit-learn
estimator over a pandas frame with `id` and `input` columns. Each `input` is an
ZIP descriptor `{"archive": <absolute archive path>, "member": <member name>}`
or a TCP descriptor `{"pcap": <absolute capture path>, "packetIndices": <indices>,
"source": {"ip": <address>, "port": <port>}, "destination": {"ip": <address>,
"port": <port>} }`. Packet indices are zero-based across all capture records;
reverse-direction packets belong to the same connection. The connection ID
uses the first observed direction; repeated endpoint tuples form one sample.
Your code reads the archive member or the indicated capture packets and chooses
its own parsing and features. The harness provides identity, not features.
Never use the id, member name or ordering as a
feature. Reuse suitable code already under `solutions/` where useful.

Execution for this task: `{{execution}}`.

- `inductive`: the harness calls `fit` on training rows, then the score method
  on disjoint validation rows.
- `batch`: the harness calls `fit_predict` (or `fit`) on the batch and scores
  that fitted batch.

The harness reads anomaly scores through `{{scoreMethod}}`, where
`{{scoreDirection}}`. The terminal refit submits your `predict` output, so the
final pipeline needs `predict`, returning `{{anomalyLabel}}` for anomalies; any
other value counts as normal.
