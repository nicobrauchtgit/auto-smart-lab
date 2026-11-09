# Identity leakage canary

Classification folds predict once more with the same fitted estimator and
unchanged bytes, but neutral `.x` validation IDs and ZIP member names. A temporary
ZIP renames all members, so opening the descriptor and inspecting `namelist()`
see neutral identities too. Collision aliases keep distinct members readable.
The check compares labels and positive-class probabilities or decision scores.
No matching-check event or agent feedback is emitted.

Changed predictions, changed scores or failure on neutral input record fold
`idLeakage`. Summary evidence is ineligible with reason `id_leakage`. Shared folds
also run this check during search and frozen-champion reruns; a leaking champion
makes the paired comparison unusable. Result validation rejects any eligible
claim carrying leakage. Finalization records one `training_id_leakage` event and
one supervisor message rendered from `training.id-leakage`, with a durable receipt
preventing repeat delivery after restart. Delivery uses the supervisor's usual
best-effort channel; a crash after the receipt may lose the message.

The canary measures prediction dependence on label suffixes. It is not isolation
of arbitrary agent Python, and it does not detect every possible use of identity
(e.g. lookup of labels from another accessible file). Scope is binary
classification; clustering IDs and pcap descriptors are not rewritten.
