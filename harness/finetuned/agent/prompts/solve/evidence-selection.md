Selection is explicitly configured on `{{metric}}` using agent-provided
labels for known development samples. Write `{{evidencePath}}` as
`{"schemaVersion":1,"labels":[{"id":"<development sample ID>","target":0}]}`.
Use integer 0 for an explicitly normal sample and 1 for an explicitly anomalous
sample. Unlabelled samples stay unlabelled. Supply sound evidence for both
classes; each validation fold needs both classes to supply a selection score.
Do not label normal by default merely because an attack was not found.

The harness snapshots this file at each accepted trial; later additions affect
only later trials. The snapshot supplies scoring labels, never fit targets or
factory inputs. Your model therefore must train without these labels. The
harness does not verify label correctness. Generated samples or mutable asset
references are not supported by this development-ID evidence contract.

Search uses the declared score unless you explicitly choose an advisory proxy.
A search winner needs a separate fixed confirmation before promotion. Promotion
requires a complete comparison on identical challenger folds and evidence,
with the paired lead exceeding noise. Report evidence class counts, coverage
and limitations; these scores do not establish official task accuracy. Keep your
binary predict decisions explicit: ranking AP does not choose a threshold.
