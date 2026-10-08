# Solve workspace

The solve agent owns the model. Fitting, folds, seeds, predictions and
measurements are owned by the harness training service in `agent/training/`.
This directory prepares what a solve run starts from.

| File | Role |
| --- | --- |
| `workspace.ts` | Run workspace: task prompt, development labels and archive without the sealed rows, research hand-off, the shared `solutions/` location |
| `folds.ts` | Fold recommendation by row count, the sealed confirmation draw, deterministic stratified folds |
| (`libs/smartlab-eval/`) | The corpus loader, installed into the venv and used by the harness workers |

## Notes for future changes

- The sealed rows are removed from the agent's archive, not only from its labels
  file: given the full archive and the development labels, the held-out set is
  exactly `members - labels`, and each training id's extension states its label.
- `smartlab_eval` is an installed, editable distribution (`libs/smartlab-eval`),
  not a directory on `PYTHONPATH`, so every reader runs the same version.
- Every loader opens the zip once. `zipfile.ZipFile()` reparses the whole central
  directory per construction, so a per-document open costs minutes instead of a
  fraction of a second.

Binary holdouts use class-based sizing rather than a fixed fraction. After the
agent and training workers close, `agent/confirmation/` measures the exact frozen
champion on sealed rows. Its immutable receipt, reuse ledger and evaluation/refit
checks are documented in [Held-back confirmation](../../docs/held-back-confirmation.md).
