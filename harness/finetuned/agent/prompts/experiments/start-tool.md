Start a training run as a supervised experiment and get an ID back immediately.

The process runs outside your tool call, so it keeps running across your turns
and across compaction, and progress reaches you while it is still going. Running
the same script with `bash` instead blocks until it finishes: you would see
nothing until the end and could not stop it on what you saw.

`argv` is an executable and its arguments, not a shell command line. Use the
project Python and a script you wrote. `scope` states the deliberately reduced
work this trial does -- a subset, one fold, a few epochs -- and is recorded with
the result, so a pilot number is never mistaken for full validation.
`hypothesis` says what you are testing.

Set `expectedGapMs` from a pilot you have already run: the longest silence a
healthy fit of this shape shows. Silence scales with data volume, so a value
learned on a subset predicts the full run. Without it the supervisor calibrates
from the gaps this run itself shows, which is slower to settle.

Print a labelled line per step from the script, with `flush=True`. What you do
not print, nobody sees.
