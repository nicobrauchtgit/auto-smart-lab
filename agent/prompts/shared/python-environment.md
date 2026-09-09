## Shared Devbox Python environment

Write reusable analysis, feature extraction, and modeling code in Python. Use
installed libraries instead of reimplementing standard ML and statistics unless
the task requires a custom implementation. Research may write and test feature
code; the modeling stage remains responsible for training the final pipeline.

Verified Python interpreter: {{pythonExecutable}}
Declared dependencies from pyproject.toml:
{{declaredDependencies}}
Environment fingerprint: {{environmentHash}}
Declared in: {{projectPath}}
Locked in: {{lockPath}} ({{totalDistributions}} distributions installed)
Shared usage notes: {{notesPath}}

`pyproject.toml` lists what this pipeline depends on directly. `uv.lock` records
the full resolved set with versions and hashes. The manager checks both files
against the installed environment at session startup. For a readable view:

```bash
{{pythonCommand}} {{managerCommand}} inspect --json
```

Rely on the declared dependencies. Everything else in the lock arrived as a
transitive dependency of one of them; check before assuming an incidental
dependency is available, and do not build on one deliberately.

The lockfile and usage notes are runtime resources, separate from repository
development AGENTS.md. Read them when you need package details.

You may add a needed Python library to this same Devbox environment:

```bash
{{pythonCommand}} {{managerCommand}} add PACKAGE --reason "Why this task needs it"
```

This resolves the package with uv, updates `pyproject.toml` and `uv.lock`,
installs it, and records the reason, requesting session, and before/after state.
Compatible dependency changes are allowed. To update an existing dependency
within the constraints already declared in `pyproject.toml`:

```bash
{{pythonCommand}} {{managerCommand}} update PACKAGE --reason "Why this task needs the update"
```

The manager lets uv resolve compatibility. Report unsatisfied constraints rather
than bypassing the resolver. Installation failures can leave partial changes;
inspect the recorded outcome before retrying. The environment is shared, so
coordinate changes with other active runs. Do not uninstall packages, create
another environment, or run a full sync as routine session startup.

Do not install with raw `pip`. A package installed behind uv's back is absent
from the lock, causes the next readiness check to fail, and is removed when the
environment is synced. Do not modify the manager's implementation or install
into system Python.

Add useful package-specific guidance to NOTES.md. Do not copy package inventories
or installed versions into Markdown; the declaration and lock files own those
facts. Change reasons belong in the manager's audit records. Keep reusable code
with the task artifacts and declare any libraries it directly depends on.
Installed locally does not mean installed on a submission server: check the task
requirements before producing code intended to execute elsewhere. Local research
and modeling are not restricted to the Python standard library.
