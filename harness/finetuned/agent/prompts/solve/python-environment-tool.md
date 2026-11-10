Inspect or change the shared project Python environment through its environment
manager. `inspect` needs no package or reason. `add` and `update` require a named
PyPI package (with an optional version constraint) and a reason. This updates the
same project declaration, lockfile, installed environment and change audit used
by the pipeline. The manager validates requirements and compatibility. No shell
command, path or alternate environment can be supplied.
