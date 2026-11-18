The lead is about to hand over trial `{{experiment}}` as the champion. Reason
given: {{reason}}
Check this trial's frozen source before the terminal refit for concrete defects
that would make its measured score misleading or its test predictions wrong:
leakage across folds, fitting on validation or test inputs, wrong output
domain or IDs, a final fit that differs from what was measured. Report only
what you can show with evidence.

Previous verification of this same measured snapshot (harness execution outcomes
and earlier findings):
{{previous}}

Continue unfinished verification. Inspect the existing scripts at the recorded
check paths, repair the checker and rerun each unsuccessful check at the same
path with run_checks. Unrelated passing checks do not resolve an outstanding
failure. A checker failure is incomplete verification, not a demonstrated
pipeline defect. Report any demonstrated pipeline defect as fix.
