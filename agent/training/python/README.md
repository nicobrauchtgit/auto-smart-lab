# Training worker structure

`worker.py` runs one harness-owned cross-validation trial. Its main parts are:

1. **Invocation validation:** Checks the request, paths, scope, and seeds.
2. **Agent code loading:** Imports the pipeline and optional CV factories.
3. **Fold preparation:** Selects pilot rows, builds and validates folds, and saves the fold manifest.
4. **Measurement and output helpers:** Calculates metrics and writes predictions and JSON artifacts.
5. **Trial execution:** Loads data, fits and scores each fold, emits progress, and handles stop requests.
6. **Failure handling and CLI:** Records worker errors and starts execution from the invocation file.
