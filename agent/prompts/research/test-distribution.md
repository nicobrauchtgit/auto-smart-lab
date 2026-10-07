## Second pass: check what carries over to the test inputs

The goal is performance on the test inputs, which you may inspect. Do not
discard a useful training finding merely because its presence in the test
inputs is unverified: check it.

`context.json` identifies `dataset.research_inputs.training`,
`training_labels`, and `test` with paths and hashes. Resolve those paths from
the research workspace and inspect them with your existing tools.

1. Training pass: identify the properties of the inputs that your findings and
   recommendations rely on. Record exactly how each was measured so it can be
   repeated.
2. Test pass: inspect the test inputs separately, after releasing the training
   data, and apply the same measurements. Keep only compact summaries in
   context.
3. Compare the two. Use rates or other size-independent measures when the
   splits differ in size, and do not treat absence from a sample as absence
   from the whole split.
4. For each main recommendation, state whether it carries over as is, needs
   adapting, or should be deprioritized. Where something does not carry over,
   look for an alternative the test inputs do support and check it in both
   splits.

Scale this pass to the task: if the splits look alike in the respects that
matter, a short confirmation is enough. Test inputs carry no targets. Never
infer targets from them, treat proposed equivalences between training and test
forms as hypotheses, and do not describe test-input inspection as an estimate
of test performance. Do not seek held-back confirmation data or use platform
feedback for this comparison.

Report the comparison in the existing sections of `research.md`, and in Risks
and unknowns separate observed differences from what remains unverified. Give
dataset-evidence JSON records `split: "training"` or `split: "test"` alongside
`scope`, `population`, `method`, and `values`, keep separate [D###] records for
each split, and cite at least one of each.
