Implement metrics.py with a pure-Python function balanced_accuracy(y_true, y_pred).
It returns the arithmetic mean of recall across the distinct labels in y_true.
The inputs are finite sequences of hashable labels. Support integer and string
labels, multiclass inputs, and a single true class. A prediction for a label
absent from y_true is incorrect and does not add a class to the mean.
Raise ValueError for empty inputs or unequal lengths. Do not use third-party
packages. Add test_metrics.py with unittest coverage and run it with:

{{python}} -m unittest -v

After the checks, run a bash command that prints CHILD_BASH_ONLY_SMOKE_MARKER.
This exercises child tool execution. Do not quote that marker in your final
reply. Return a short summary with file paths and actual
test results. Keep all file changes in the current workspace; do not install
dependencies or change environment configuration.
