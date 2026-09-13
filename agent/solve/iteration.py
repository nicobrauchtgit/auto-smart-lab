"""Measure one solve iteration and emit the signal as JSON on stdout.

Everything numeric lives here so there is one implementation of balanced
accuracy, the paired bootstrap, and the sealed-set scoring rather than one per
language. The stage reads this JSON, records it, and renders the part the agent
is shown.

Nothing here judges an approach or suggests what to try next. It reports what
the predictions actually say.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from smartlab_eval import metrics as m
from smartlab_eval.corpus import id_form_hint

from .canary import run_canary
from .convergence import capture_convergence_warnings, summarise
from .corpus import load_examples
from .entrypoint import load_factory

TOLERANCE = 1e-9


def _read_delimited(path: Path) -> list[dict[str, str]]:
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split(";")
    rows = []
    for number, line in enumerate(lines[1:], start=2):
        fields = line.split(";")
        if len(fields) != len(header):
            raise ValueError(f"{path.name} line {number}: expected {len(header)} fields, found {len(fields)}")
        rows.append(dict(zip(header, fields)))
    return rows


def _labels(path: Path) -> dict[str, int]:
    table: dict[str, int] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        row_id, _, raw = line.rpartition(";")
        if not row_id or raw not in {"0", "1"}:
            raise ValueError(f"{path.name} line {number} is not a path;binary-label record")
        table[row_id] = int(raw)
    return table


def evaluate(arguments: argparse.Namespace) -> dict:
    workspace = Path(arguments.workspace)
    project_root = Path(arguments.project_root)

    # A missing or malformed contract leaves nothing to measure at all. Every
    # later failure is a failure of the results, not of the run, and is reported
    # alongside whatever could still be computed.
    metrics_path = workspace / "metrics.json"
    if not metrics_path.is_file():
        return {"ok": False, "errors": ["metrics.json was not written"]}
    try:
        reported = json.loads(metrics_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return {"ok": False, "errors": [f"metrics.json is not valid JSON: {error}"]}
    if reported.get("schema_version") != 1:
        return {"ok": False, "errors": [f"metrics.json schema_version must be 1, found {reported.get('schema_version')!r}"]}
    # The harness scaffolds this file, so its location and factory name are known
    # before the agent writes anything. Declaring them is how an agent moves the
    # entrypoint, not a hoop it has to clear to keep it where we put it.
    entrypoint = reported.get("entrypoint") or {}
    entrypoint = {
        "module": entrypoint.get("module") or arguments.entrypoint_module,
        "factory": entrypoint.get("factory") or "build_pipeline",
    }
    if not entrypoint["module"]:
        return {"ok": False, "errors": ["metrics.json entrypoint must name a module, and no default was supplied"]}

    oof_path = workspace / "oof_predictions.csv"
    if not oof_path.is_file():
        return {"ok": False, "errors": ["oof_predictions.csv was not written"]}

    labels = _labels(Path(arguments.labels))
    sealed = [line.strip() for line in Path(arguments.sealed).read_text(encoding="utf-8").splitlines() if line.strip()]
    sealed_set = set(sealed)
    dev_ids = {row_id for row_id in labels if row_id not in sealed_set}

    try:
        oof_rows = _read_delimited(oof_path)
    except ValueError as error:
        return {"ok": False, "errors": [str(error)]}

    missing_columns = _missing_columns(oof_rows)
    if missing_columns:
        errors = missing_columns
        oof_rows = []
    else:
        errors = _compliance_errors(oof_rows, labels, sealed_set, dev_ids)

    scorable = [row for row in oof_rows if row["id"] in labels and row["id"] not in sealed_set]
    by_repeat: dict[int, list[dict[str, str]]] = {}
    try:
        for row in scorable:
            by_repeat.setdefault(int(row["repeat"]), []).append(row)
    except ValueError:
        by_repeat = {}

    recomputed = _recompute(by_repeat, labels) if by_repeat else None
    if recomputed is None and not errors:
        # Compliant rows that still yield no scorable fold mean the folds
        # themselves are unusable, most often an unstratified split that put one
        # class entirely outside a validation fold.
        errors.append(
            "no fold in oof_predictions.csv holds both classes, so nothing could be scored; "
            "the split has to be stratified",
        )

    # Compliance decides whether the iteration is measurable. It does not decide
    # whether anything can be said about the model: an id written in the wrong
    # form makes the score uncomparable but leaves the predictions, and the
    # pipeline itself, just as inspectable. Everything below is computed either
    # way, and `ok` alone gates promotion.
    signal: dict = {
        "ok": not errors,
        "errors": errors,
        "reported": _reported_summary(reported),
        "entrypoint": entrypoint,
    }

    if recomputed is not None:
        signal["recomputed"] = recomputed
        signal["coverage"] = {
            "scored": len({row["id"] for row in scorable}),
            "development_rows": len(dev_ids),
            "complete": not errors,
        }
        curves = _curves(by_repeat, labels)
        signal.update(curves)

    # Comparing a reported figure against a partial recomputation would report a
    # disagreement that is an artefact of the missing rows.
    signal["discrepancies"] = (
        _discrepancies(reported, recomputed["mean_bacc"]) if recomputed is not None and not errors else []
    )

    # The canary reads the agent's entrypoint and its own sample of the corpus.
    # It depends on nothing the results files say, so it is the one measurement
    # that survives any compliance failure -- including the failures that would
    # otherwise leave an iteration with no feedback whatsoever.
    canary = run_canary(
        project_root=project_root,
        zip_path=Path(arguments.zip),
        module_path=entrypoint["module"],
        factory_name=entrypoint["factory"],
        ids=sorted(dev_ids),
        labels=[labels[row_id] for row_id in sorted(dev_ids)],
        seed=arguments.seed,
    )
    signal["canary"] = canary.as_dict()
    if canary.convergence:
        signal["convergence"] = canary.convergence
    cost = _cost(canary, len(dev_ids), arguments.folds, arguments.session_seconds)
    if cost is not None:
        signal["cost"] = cost

    if errors:
        return signal

    sealed_result = _score_sealed(
        project_root=project_root,
        zip_path=Path(arguments.zip),
        entrypoint=entrypoint,
        labels=labels,
        dev_ids=sorted(dev_ids),
        sealed_ids=sealed,
    )
    if sealed_result.get("error"):
        signal["ok"] = False
        signal["errors"] = [sealed_result["error"]]
        return signal
    # The sealed scoring fits the declared factory on every development row, so
    # its iteration counts describe a full-size fit rather than the canary's
    # sample. The fit itself sees no sealed row, so nothing here reveals the
    # held-out split.
    if sealed_result.get("convergence"):
        signal["convergence"] = sealed_result["convergence"]
    # Held back from the agent until the final iteration. A gap that widens
    # across iterations is the loop overfitting its own folds.
    signal["sealed"] = {
        "n": sealed_result["n"],
        "bacc": sealed_result["bacc"],
        "gap": sealed_result["bacc"] - recomputed["mean_bacc"],
    }

    signal["paired"] = _paired(arguments, project_root, labels, by_repeat, recomputed["mean_bacc"])
    return signal


def _missing_columns(oof_rows: list[dict[str, str]]) -> list[str]:
    """The columns every later check indexes by name.

    Checked first and separately: without them nothing downstream can read a
    row, and a column-shaped mistake reported as thousands of missing
    predictions reads as the wrong problem.
    """
    errors = []
    for name, rows, required in (
        ("oof_predictions.csv", oof_rows, ("id", "repeat", "fold", "prediction")),
    ):
        if not rows:
            errors.append(f"{name} holds no prediction rows")
            continue
        absent = [column for column in required if column not in rows[0]]
        if absent:
            errors.append(f"{name} is missing the column(s) {', '.join(absent)}; it needs {';'.join(required)}")
    return errors


def _compliance_errors(
    oof_rows: list[dict[str, str]],
    labels: dict[str, int],
    sealed_set: set[str],
    dev_ids: set[str],
) -> list[str]:
    """Check that the reported score covers the development set and only it.

    Compliance is a check on the measurement, not on the model: it establishes
    that two iterations are comparable and that the sealed split stayed sealed.
    """
    errors: list[str] = []
    oof_ids = {row["id"] for row in oof_rows}

    leaked = sorted(oof_ids & sealed_set)
    if leaked:
        errors.append(
            f"{len(leaked)} sealed id(s) appear in oof_predictions.csv, first {leaked[0]}; "
            "the confirmation split must stay out of cross-validation",
        )
    unknown = sorted(oof_ids - set(labels))
    if unknown:
        errors.append(f"{len(unknown)} oof id(s) are not in the labels file, first {unknown[0]}{id_form_hint(unknown, labels)}")

    by_repeat: dict[int, list[str]] = {}
    for row in oof_rows:
        by_repeat.setdefault(int(row["repeat"]), []).append(row["id"])
    for repeat, ids in sorted(by_repeat.items()):
        if len(ids) != len(set(ids)):
            errors.append(f"repeat {repeat} predicts some ids more than once")
        missing = dev_ids - set(ids)
        if missing:
            errors.append(
                f"repeat {repeat} is missing {len(missing)} of {len(dev_ids)} development rows; "
                "every development row needs an out-of-fold prediction",
            )

    return errors


def _score_sealed(
    project_root: Path,
    zip_path: Path,
    entrypoint: dict,
    labels: dict[str, int],
    dev_ids: list[str],
    sealed_ids: list[str],
) -> dict:
    """Score the held-out split by running the agent's own pipeline over it.

    The split is never given to the agent, so there are no agent-supplied
    predictions here to trust, to check for coverage, or to fabricate from the
    label-bearing extensions. The harness fits the declared factory on the
    development rows and predicts the held-out rows itself.

    That makes this number mean what it claims: an estimate produced by the same
    pipeline the agent built, on rows that took no part in building it. It is the
    factory that is measured, which is the same thing the leakage canary and the
    paired champion comparison already re-run.
    """
    if not sealed_ids:
        return {"error": "the held-out split is empty"}
    truth = [labels[row_id] for row_id in sealed_ids]
    if len(set(truth)) < 2:
        return {"error": "the held-out split holds only one class, so it cannot be scored on balanced accuracy"}
    try:
        factory = load_factory(project_root, entrypoint["module"], entrypoint["factory"])
        development = load_examples(zip_path, dev_ids)
        with capture_convergence_warnings() as raised:
            model = factory().fit(development, [labels[row_id] for row_id in dev_ids])
        convergence = summarise(model, "development_rows", len(dev_ids), raised)
        held_out = load_examples(zip_path, list(sealed_ids))
        predicted = [int(value) for value in model.predict(held_out)]
    except Exception as error:
        return {"error": f"the held-out split could not be scored: {type(error).__name__}: {error}"}
    return {"n": len(sealed_ids), "bacc": m.balanced_accuracy(truth, predicted), "convergence": convergence}


def _cost(canary, development_rows: int, folds: int, session_seconds: float) -> dict | None:
    """Project the cost of a full cross-validation pass from the canary's fit.

    The canary already fits the agent's pipeline on a small sample, so the price
    of its representation is measurable at no extra cost. Without this the only
    signal about an expensive pipeline is the session running out, which arrives
    after the budget has been spent rather than before.

    The projection assumes fit time grows linearly with rows. Many estimators are
    superlinear, so this is a floor, not a forecast -- which is the useful
    direction for a warning to err in.
    """
    if canary.examples < 2 or canary.fit_seconds <= 0 or folds < 2:
        return None
    per_row = canary.fit_seconds / canary.examples
    # Each fold trains on all but its own share of the development rows.
    train_rows = development_rows * (folds - 1) / folds
    cv_seconds = per_row * train_rows * folds
    cost = {
        "fit_seconds": canary.fit_seconds,
        "fit_rows": canary.examples,
        "seconds_per_1000_rows": per_row * 1000,
        "estimated_cv_seconds": cv_seconds,
        "development_rows": development_rows,
        "folds": folds,
    }
    if session_seconds > 0:
        cost["session_seconds"] = session_seconds
        cost["share_of_session"] = cv_seconds / session_seconds
    return cost


def _recompute(by_repeat: dict[int, list[dict[str, str]]], labels: dict[str, int]) -> dict | None:
    """Recompute rather than trust.

    The number that reaches telemetry is derived from the predictions, not from
    what the agent said about them. Folds that hold a single class are skipped
    instead of failing the whole recomputation, so a partial set of rows still
    yields the folds it can score.
    """
    fold_scores = []
    for repeat, rows in sorted(by_repeat.items()):
        for fold in sorted({int(row["fold"]) for row in rows}):
            group = [row for row in rows if int(row["fold"]) == fold]
            truth = [labels[row["id"]] for row in group]
            if len(set(truth)) < 2:
                continue
            predicted = [int(row["prediction"]) for row in group]
            fold_scores.append(m.score_fold(repeat, fold, truth, predicted).as_dict())
    if not fold_scores:
        return None
    pooled_scores = [
        m.balanced_accuracy([labels[row["id"]] for row in rows], [int(row["prediction"]) for row in rows])
        for rows in by_repeat.values()
        if len({labels[row["id"]] for row in rows}) == 2
    ]
    return {
        "mean_bacc": float(np.mean([fold["bacc"] for fold in fold_scores])),
        "pooled_bacc": float(np.mean(pooled_scores)) if pooled_scores else float(np.mean([fold["bacc"] for fold in fold_scores])),
        "fold_low": min(fold["bacc"] for fold in fold_scores),
        "fold_high": max(fold["bacc"] for fold in fold_scores),
        "recall_0": float(np.mean([fold["recall_0"] for fold in fold_scores])),
        "recall_1": float(np.mean([fold["recall_1"] for fold in fold_scores])),
        "folds": fold_scores,
    }


def _discrepancies(reported: dict, recomputed_mean: float) -> list[dict]:
    if "mean_bacc" not in reported:
        return []
    try:
        stated = float(reported["mean_bacc"])
    except (TypeError, ValueError):
        return []
    if abs(stated - recomputed_mean) <= TOLERANCE:
        return []
    return [{"field": "mean_bacc", "reported": stated, "recomputed": recomputed_mean}]


def _curves(by_repeat: dict[int, list[dict[str, str]]], labels: dict[str, int]) -> dict:
    """ROC and threshold diagnostics, when the agent supplied scores."""
    primary = by_repeat[min(by_repeat)]
    if not primary or not all("score" in row for row in primary):
        return {}
    truth = [labels[row["id"]] for row in primary]
    try:
        scores = [float(row["score"]) for row in primary]
    except ValueError:
        return {}
    if len(set(truth)) != 2 or len(set(scores)) <= 1:
        return {}
    sweep = m.threshold_sweep(truth, scores)
    return {
        "roc_auc": m.roc(truth, scores).auc,
        "threshold": {key: sweep[key] for key in ("best_threshold", "best_balanced_accuracy", "at_default_threshold", "plateau")},
    }


def _reported_summary(reported: dict) -> dict:
    return {
        key: reported.get(key)
        for key in ("mean_bacc", "pooled_bacc", "approach", "variants_compared", "done", "cv")
    }


def _paired(arguments, project_root: Path, labels: dict[str, int], by_repeat, challenger_mean: float):
    """Champion versus challenger on identical example groupings."""
    if not arguments.champion_module:
        return None
    primary = by_repeat[min(by_repeat)]
    ids = [row["id"] for row in primary]
    truth = [labels[row_id] for row_id in ids]
    challenger = [int(row["prediction"]) for row in primary]
    fold_of = {row["id"]: int(row["fold"]) for row in primary}

    try:
        champion = _run_champion(arguments, ids)
    except Exception as error:
        return {"available": False, "reason": f"champion could not be re-run: {error}"}

    baseline = champion["predictions"]
    comparison = m.compare(truth, baseline, challenger)
    interval = m.paired_bootstrap(truth, baseline, challenger, resamples=arguments.bootstrap_resamples, seed=arguments.seed)

    # Fold-level agreement uses the challenger's own grouping, applied to both
    # prediction vectors, so a gain concentrated in one fold is visible.
    improved = 0
    total = 0
    for fold in sorted(set(fold_of.values())):
        rows = [index for index, row_id in enumerate(ids) if fold_of[row_id] == fold]
        fold_truth = [truth[index] for index in rows]
        if len(set(fold_truth)) < 2:
            continue
        total += 1
        challenger_score = m.balanced_accuracy(fold_truth, [challenger[index] for index in rows])
        champion_score = m.balanced_accuracy(fold_truth, [baseline[index] for index in rows])
        improved += int(challenger_score > champion_score)

    champion_recall = m.per_class_recall(truth, baseline)
    challenger_recall = m.per_class_recall(truth, challenger)
    return {
        "available": True,
        "champion_bacc": comparison["baseline_balanced_accuracy"],
        "challenger_bacc": comparison["candidate_balanced_accuracy"],
        "delta": interval["delta"],
        "low": interval["low"],
        "high": interval["high"],
        "clears_zero": interval["clears_zero"],
        "corrected": comparison["corrected"],
        "introduced": comparison["introduced"],
        "folds_improved": improved,
        "folds_total": total,
        "recall_0_delta": challenger_recall["recall_0"] - champion_recall["recall_0"],
        "recall_1_delta": challenger_recall["recall_1"] - champion_recall["recall_1"],
    }


def _run_champion(arguments, ids: list[str]) -> dict:
    """Re-run the champion snapshot in its own interpreter.

    The snapshot and the current tree normally use the same module names, so
    importing both here would give the second one Python's cached copy of the
    first and quietly compare the challenger with itself.
    """
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
        handle.write("\n".join(ids))
        id_file = handle.name
    try:
        finished = subprocess.run(
            [sys.executable, "-m", "solve.champion",
             "--root", str(arguments.champion_root or arguments.project_root),
             "--zip", str(arguments.zip),
             "--module", arguments.champion_module,
             "--factory", arguments.champion_factory,
             "--ids", id_file,
             "--labels", str(arguments.labels),
             "--folds", str(arguments.folds),
             "--seed", str(arguments.seed)],
            capture_output=True, text=True, cwd=str(Path(__file__).resolve().parents[1]),
        )
        if finished.returncode != 0:
            tail = finished.stderr.strip().splitlines()
            raise RuntimeError(tail[-1] if tail else "no diagnostics")
        return json.loads(finished.stdout)
    finally:
        Path(id_file).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure one solve iteration")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--labels", required=True, help="full labels file, including sealed rows")
    parser.add_argument("--sealed", required=True, help="sealed_ids.txt")
    parser.add_argument("--zip", required=True, help="training zip")
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--bootstrap-resamples", type=int, default=2000)
    parser.add_argument("--entrypoint-module", default="",
                        help="scaffolded entrypoint path, used when metrics.json omits one")
    parser.add_argument("--session-seconds", type=float, default=0.0,
                        help="agent session budget, so the projected cost can be stated against it")
    parser.add_argument("--champion-module", default="")
    parser.add_argument("--champion-factory", default="build_pipeline")
    parser.add_argument("--champion-root", default="")
    arguments = parser.parse_args(argv)
    try:
        signal = evaluate(arguments)
    except Exception as error:  # the stage needs a result, not a traceback
        signal = {"ok": False, "errors": [f"{type(error).__name__}: {error}"]}
    json.dump(signal, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
