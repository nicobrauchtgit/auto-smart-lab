"""Read-only measurement verification. Never imports user models, fits, or reads sealed/test data."""
import csv
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "training" / "python"))
from smartlab_trial.invocation import parse_invocation
from smartlab_trial.measurement import load_samples, primary_score, selection_receipt
from smartlab_trial.anomaly_measurements import evidence
from sklearn.metrics import adjusted_rand_score
from smartlab_trial.metrics import _measure
from smartlab_trial.recovery import digest, load_checkpoint, persisted_folds, validate_single
from smartlab_trial.folds import _pilot_indices
from smartlab_trial.seeds import _derive_seed


def verify(directory):
    document = json.loads((directory / "invocation.json").read_text())
    invocation = parse_invocation(document)
    assert invocation.measurement
    spec = invocation.measurement
    frame, targets, _digest = load_samples(spec)
    task_kind = spec["kind"]
    labels = dict(zip(frame["id"].tolist(), targets)) if targets is not None else None
    ids = frame["id"].tolist()
    # Pilot folds may use a deterministic subset; retain the harness's persisted cohort.
    if invocation.scope.kind == "pilot" and invocation.scope.max_rows is not None:
        indices = _pilot_indices(targets if targets is not None else [0] * len(ids), min(invocation.scope.max_rows, len(ids)), _derive_seed("pilot", [invocation.trial_seed]))
        ids = [ids[index] for index in indices]
    folds, manifest = persisted_folds(invocation, ids)
    parameters = None
    if invocation.search:
        checkpoint = load_checkpoint(directory / "search-checkpoint.json")
        search = invocation.search
        identity = digest({"experimentId": invocation.experiment_id, "trialSeed": invocation.trial_seed,
                           "pipeline": invocation.request.get("pipeline"), "cv": invocation.request.get("cv"),
                           "scope": invocation.request.get("scope"), "space": search.space, "sampler": search.sampler,
                           "maxConfigs": search.max_configs, "pruning": search.pruning})
        assert checkpoint["searchIdentity"] == identity and checkpoint["trialSeed"] == invocation.trial_seed
        completed_configs = [row for row in checkpoint["results"] if row["status"] == "completed"]
        assert completed_configs
        best = sorted(completed_configs, key=lambda row: (-statistics.fmean(primary_score(f["metrics"]) for f in row["folds"]), row["index"]))[0]
        report = json.loads((directory / "search-report.json").read_text())
        result = json.loads((directory / "trial-result.json").read_text())
        assert result["search"]["bestConfigId"] == best["config_id"] and result["promotionEligible"] is False
        assert any(row["configId"] == best["config_id"] and row["params"] == best["params"] for row in report["leaderboard"])
        checkpoint = {"experimentId": invocation.experiment_id, "manifestSha256": manifest["sha256"], "completed": best["folds"], "oof": best["oof"]}
        parameters = {"configId": best["config_id"], "searched": best["params"]}
    else:
        checkpoint = load_checkpoint(directory / "single-checkpoint.json")
    completed, rows = validate_single(checkpoint, invocation, manifest, folds, ids)
    assert len(completed) == len(folds) and rows
    assert all(row["prediction"] == "" or type(row["prediction"]) is int for row in rows)
    result = json.loads((directory / "trial-result.json").read_text())
    assert result["status"] == "completed"
    assert json.loads((directory / "metrics.json").read_text()) == result
    assert [json.loads(line) for line in (directory / "fold-results.jsonl").read_text().splitlines() if line] == completed
    verified_folds = []
    for fold, measurement in zip(folds, completed):
        fold_rows = [row for row in rows if row["repeat"] == fold.repeat and row["fold"] == fold.fold]
        predictions = [row["prediction"] for row in fold_rows]
        if task_kind == "classification":
            assert all(value in (0, 1) for value in predictions)
            measured = _measure([labels[row["id"]] for row in fold_rows], predictions)
        elif task_kind == "clustering":
            assert labels is not None and all(type(value) is int for value in predictions)
            measured = {"adjustedRandIndex": float(adjusted_rand_score([labels[row["id"]] for row in fold_rows], predictions))}
        else:
            assert spec.get("selection") and "diagnosticEvidence" in frame.attrs
            batch = frame.set_index("id", drop=False).loc[[row["id"] for row in fold_rows]].reset_index(drop=True)
            raw_scores = [row["score"] for row in fold_rows]
            predicted = None if all(value == "" for value in predictions) else predictions
            assert predicted is None or all(type(value) is int for value in predicted)
            receipt = selection_receipt(spec, evidence(batch, raw_scores, predicted, frame.attrs["diagnosticEvidence"], spec))
            assert receipt["available"] is True and measurement["selection"] == receipt
            measured = {"selectionScore": receipt["value"]}
        assert measurement["metrics"] == measured
        verified_folds.append(measured)
    if task_kind == "classification":
        aggregate = _measure([labels[row["id"]] for row in rows], [row["prediction"] for row in rows])
        assert result["metrics"] == aggregate
    else:
        field = "adjustedRandIndex" if task_kind == "clustering" else "selectionScore"
        aggregate = {field: statistics.fmean(fold[field] for fold in verified_folds)}
        assert math.isclose(result["metrics"][field], aggregate[field], rel_tol=1e-12, abs_tol=1e-12)
        aggregate[field] = result["metrics"][field]
        assert set(result["metrics"]) <= {field, "aggregation"}
        if task_kind == "anomaly_detection":
            for key, expected in {**spec["selection"], "source": spec["evidence"]["source"],
                                  "evidenceSha256": spec["evidenceManifestSha256"],
                                  "folds": [fold["selection"] for fold in completed]}.items():
                assert result["selection"][key] == expected
    with (directory / "oof_predictions.csv").open(newline="") as stream:
        observed_rows = list(csv.DictReader(stream, delimiter=";"))
    assert len(observed_rows) == len(rows)
    for observed, expected in zip(observed_rows, rows):
        assert observed["id"] == expected["id"]
        for key in ("repeat", "fold"):
            assert int(observed[key]) == expected[key]
        assert observed["prediction"] == str(expected["prediction"])
        assert observed["score"] == str(expected["score"])
    return {"verified": True, "parameters": parameters, "metrics": aggregate}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(Path(sys.argv[1]))))
    except Exception:
        # No raw labels, model output, paths or provider data on failure.
        print('{"verified": false}')
        sys.exit(1)
