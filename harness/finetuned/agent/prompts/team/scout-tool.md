Ask one or several scouts a focused question with evidence references. Blocks
until all selected scouts finish; returns their final bullets only, plus an
error line for any scout that failed. Data inspects inputs; ideas reads course
material and searches; validation checks one measured trial and needs exactly
one `{experiment}` reference (or a `{check, experiment}` reference): it reads
that trial's frozen source and runs checks against it, never live code, and
answers with ok, fix or advice bullets. Earlier findings from this run are
supplied to avoid repetition.

Use this tool iteratively: consult data about input uncertainties, ideas about
a focused hypothesis or measured weakness, and validation about a concrete
concern in a measured trial. Ground follow-ups in harness results and relevant
evidence references; use the answers to choose the next harness-run trial.
Keep model comparisons in the harness and avoid repeating answered questions.

Each selected role runs in sequence and receives a fresh role-specific
tool-call allowance on every invocation. Its internal calls do not consume
the lead's budget; this explicit scout request costs the lead one call.
Validation invoked through hand_over is free for the lead and retains its
own scout limits.
