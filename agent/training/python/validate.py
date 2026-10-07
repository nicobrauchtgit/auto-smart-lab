"""Validate one experiment request against the real pipeline without fitting.

Reads ``{"sourceRoot": ..., "request": ...}`` from stdin and writes
``{"issues": [...]}`` to stdout. The harness bounds the run time and treats a
crash or timeout as a rejection, never as a pass.
"""
from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path

from smartlab_trial.validation import validate_request


def main() -> int:
    document = json.loads(sys.stdin.read())
    # Agent code may print while importing; only the report belongs on stdout.
    with contextlib.redirect_stdout(sys.stderr):
        issues = validate_request(Path(document["sourceRoot"]).resolve(), document["request"])
    sys.stdout.write(json.dumps({"issues": issues}, allow_nan=False, default=repr))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
