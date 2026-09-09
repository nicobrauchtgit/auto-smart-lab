"""Load the solve agent's declared orchestration entrypoint.

`metrics.json` names a module path and a factory. The factory returns an
unfitted estimator whose `fit(X, y)` and `predict(X)` take a frame with `id` and
`text` columns. That one convention is what lets the harness re-run the agent's
own pipeline for the leakage canary and the paired champion comparison; it says
nothing about features, model, or structure.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_factory(project_root: Path, module_path: str, factory: str):
    """Load a dotted module name or a .py path relative to `project_root`."""
    if not module_path.endswith(".py"):
        module_path = module_path.replace(".", "/") + ".py"
    target = (project_root / module_path).resolve()
    if not target.is_file():
        raise FileNotFoundError(f"entrypoint module does not exist: {module_path}")
    if project_root.resolve() not in target.parents:
        raise ValueError(f"entrypoint module escapes the project: {module_path}")
    # Solution modules import their own siblings, so the tree has to be importable.
    root = str(project_root.resolve())
    if root not in sys.path:
        sys.path.insert(0, root)

    name = f"_solve_entrypoint_{target.stem}"
    spec = importlib.util.spec_from_file_location(name, target)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)

    if not hasattr(module, factory):
        raise AttributeError(f"{module_path} does not define {factory}()")
    resolved = getattr(module, factory)
    if not callable(resolved):
        raise TypeError(f"{module_path}.{factory} is not callable")
    return resolved
