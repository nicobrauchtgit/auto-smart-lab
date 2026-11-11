Ask one or several scouts a focused question with evidence references. Blocks
until all selected scouts finish; returns their final bullets only, plus an
error line for any scout that failed. Data inspects inputs; ideas reads course
material and searches; validation checks one measured trial and needs exactly
one `{experiment}` reference (or a `{check, experiment}` reference): it reads
that trial's frozen source and runs checks against it, never live code, and
answers with ok, fix or advice bullets. Earlier findings from this run are
supplied to avoid repetition.
