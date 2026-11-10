# scikit-learn observability measurements

Evidence behind [experiment-supervision.md](../../experiment-supervision.md).
Measured 2026-09-09 against the real corpora, on macOS Darwin 25, Apple Silicon,
scikit-learn 1.9.0. Reference material, not part of the pipeline.

| File | What it is |
| --- | --- |
| `procinfo.py` | CPU and RSS for a process group through libproc. The supervisor's sampler starts here |
| `observe.py` | Supervisor stand-in: detached spawn, timestamped line drain, process-group sampling, group kill on deadline |
| `fit_case.py` | Trial fits covering every regime, including deliberately stuck ones. Selectable with `TASK=spam1\|spam2` |
| `analyse.py` | Gap distribution and resource use for one task |
| `compare.py` | Side-by-side comparison across tasks |
| `design-notes-sklearn-1.9.md` | Supplied design notes on sklearn 1.9 telemetry. Its section 5 event model was not adopted; see the main doc |
| `obs-*.jsonl` | Local recordings, excluded from Git; generate them when reproducing the measurements |

Reproduce with:

```bash
P="$PWD/.venv/bin/python"
TASK=spam2 DEADLINE=1200 $P -u docs/research/sklearn-observability/observe.py "$P" "$PWD" crossval_silent nb_batched
$P docs/research/sklearn-observability/compare.py
```

Two things this code exists to stop the next implementation getting wrong.
`ps -o time,rss,vsz` fails on Darwin 25 with `requires entitlement`, so CPU and
memory come from `proc_pidinfo`. Its CPU fields are mach ticks, not nanoseconds:
on Apple Silicon the timebase is 125/3, and reading them as nanoseconds reports
2.4% for a fully pegged core.
