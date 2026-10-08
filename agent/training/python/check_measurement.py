"""Bounded metadata/import preflight; never import or fit agent pipelines."""
import argparse
import json

from smartlab_trial import diagnostics
from smartlab_trial.measurement import load_samples, validate_config
from smartlab_trial.folds import _materialize_folds


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--config")
    mode.add_argument("--check-imports", action="store_true")
    args = parser.parse_args()
    try:
        if args.check_imports:
            print(json.dumps({"imports": True}))
            raise SystemExit(0)
        config = validate_config(json.loads(args.config))
        frame, targets, digest = load_samples(config)
        print(json.dumps({"rows": len(frame), "hasTargets": targets is not None, "sha256": digest}))
    except Exception as error:
        print(json.dumps({"error": {"type": type(error).__name__, "message": str(error)}}))
        raise SystemExit(1)
