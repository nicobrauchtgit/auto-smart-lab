Run Python checks you wrote against the frozen snapshot of the trial under
validation. Each path must be a `.py` file in your checks folder. Each check
runs in its own fresh Python process with the snapshot first on the import
path; it passes when it exits with status 0. Returns each check's exit status
and the end of its output.
