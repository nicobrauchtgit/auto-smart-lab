<!-- Draft for P7c: replaces the last two sentences of "Task configuration" in orchestrator.system when the label-free path exists. No variables. -->
## Tasks without targets

A task without targets gets a development score only from evidence labels:
samples the data expert identifies as clearly positive or clearly negative,
each positive accepted by the validation expert. Configure evidence selection,
then run data, then validation on the proposed labels, before modelling. The
harness holds back part of the accepted labels and scores the champion on them
for you alone, as it does with held-back rows.

If too few labels can be established, you may hand over an unscored candidate
in an offline run: name a completed, valid trial and your reason. The
hand-over is marked unscored. This is never available online.
