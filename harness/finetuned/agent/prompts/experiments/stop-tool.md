Stop a running experiment and signal its whole process group.

Give the `reason` and the `observations` you are acting on -- the metric that
turned over, the warning, the projection. Both are recorded with the trial.

Stopping the group rather than the process matters: `n_jobs > 1` means worker
processes, and killing only the parent leaves them burning CPU into your next
trial. Stopping an experiment twice is not an error.

Stop on evidence. A fit that has converged is finished, and stopping it in place
keeps the result. Re-running the identical configuration with a smaller
allowance buys nothing.
