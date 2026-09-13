Current state of a supervised experiment: status, elapsed time, lines emitted,
time since the last output, CPU percent, resident memory, and process count.

CPU proves liveness, not usefulness. A trial doing arithmetic that will be
discarded reads 105% and looks exactly like productive work; only the loss or
validation series tells you which it is. A group at roughly 0% CPU that has been
silent past this trial's derived threshold is reported as stalled.

Above 100% is normal: it means several processes, which is what `n_jobs > 1`
does.
