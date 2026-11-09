# Shared Python usage notes

Pipeline agents may add package-specific usage notes and reproducibility advice
here. Include the task and relevant API behavior.

Do not record which versions are installed. `pyproject.toml` declares the
dependencies and `uv.lock` records the resolved versions. A version written here
would be a second claim that can go stale. Installation reasons and the requesting
pipeline run are in `changes.jsonl`.

Use this file for advice that is not derivable from the lock: an API quirk, a
parameter that matters for a task, a reason to prefer one function over another.
