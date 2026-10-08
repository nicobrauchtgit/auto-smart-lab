"""Check original development measurements without fitting or sealed labels."""
import csv
import json
import math
from pathlib import Path

from smartlab_eval import load_labels
from smartlab_trial.invocation import parse_invocation
from smartlab_trial.measurement import load_samples, selection_receipt
from smartlab_trial.recovery import load_checkpoint, persisted_folds, validate_single
from smartlab_trial.metrics import _measure


def validate(directory):
    document = json.loads((directory / 'invocation.json').read_text())
    invocation = parse_invocation(document)
    assert not invocation.search and invocation.scope.kind == 'promotion'
    if invocation.measurement:
        return validate_samples(directory, document, invocation)
    labels = load_labels(invocation.labels_path)
    ids = sorted(labels)
    folds, manifest = persisted_folds(invocation, ids)
    checkpoint = load_checkpoint(directory / 'single-checkpoint.json')
    completed, rows = validate_single(checkpoint, invocation, manifest, folds, ids)
    assert len(completed) == len(folds) and all(row['prediction'] in (0, 1) for row in rows)
    result = json.loads((directory / 'trial-result.json').read_text())
    metrics = json.loads((directory / 'metrics.json').read_text())
    assert result['status'] == 'completed' and result['promotionEligible'] is True
    assert result['metrics'] == _measure([labels[row['id']] for row in rows], [row['prediction'] for row in rows]), 'Corrupt measured metrics'
    assert metrics == result, 'Metrics and result differ'
    measured = [json.loads(line) for line in (directory / 'fold-results.jsonl').read_text().splitlines() if line]
    assert measured == completed, 'Fold measurements differ from checkpoint'
    with (directory / 'oof_predictions.csv').open(newline='') as stream:
        predictions = list(csv.DictReader(stream, delimiter=';'))
    assert len(predictions) == len(rows)
    for observed, expected in zip(predictions, rows):
        assert observed['id'] == expected['id']
        for key in ('repeat', 'fold', 'prediction'):
            assert int(observed[key]) == expected[key], 'OOF predictions differ from checkpoint'
        assert observed['score'] == str(expected['score']), 'OOF scores differ from checkpoint'
    assert result['source']['commit'] == document['source']['commit'] and result['source']['tree'] == document['source']['tree']


def validate_samples(directory, document, invocation):
    """Promotable sample evidence is classification or labelled clustering; recompute its metric."""
    from sklearn.metrics import adjusted_rand_score
    frame, targets, _digest = load_samples(invocation.measurement)
    kind = invocation.measurement['kind']
    assert (kind in ('classification', 'clustering') and targets is not None) or (kind == 'anomaly_detection' and invocation.measurement.get('selection')), 'Only declared selection evidence can be promoted'
    ids = frame['id'].tolist()
    target_by_id = dict(zip(ids, targets)) if targets is not None else {}
    folds, manifest = persisted_folds(invocation, ids)
    checkpoint = load_checkpoint(directory / 'single-checkpoint.json')
    completed, rows = validate_single(checkpoint, invocation, manifest, folds, ids)
    assert len(completed) == len(folds) and all(type(row['prediction']) is int for row in rows)
    result = json.loads((directory / 'trial-result.json').read_text())
    if kind == 'anomaly_detection':
        from smartlab_trial.anomaly_measurements import evidence
        import numpy as np
        metadata = frame.attrs['diagnosticEvidence']
        for fold in completed:
            batch = [row for row in rows if (row['repeat'], row['fold']) == (fold['repeat'], fold['fold'])]
            positions = {row_id: index for index, row_id in enumerate(ids)}
            validation = frame.iloc[[positions[row['id']] for row in batch]].reset_index(drop=True)
            measured = evidence(validation, np.asarray([row['score'] for row in batch], dtype=float),
                                [row['prediction'] for row in batch], metadata, invocation.measurement)
            receipt = selection_receipt(invocation.measurement, measured)
            assert receipt['available'] and receipt == fold['selection'], 'Corrupt selection receipt'
            assert math.isclose(receipt['value'], fold['metrics']['selectionScore'], abs_tol=1e-12), 'Corrupt selection score'
        mean = sum(fold['metrics']['selectionScore'] for fold in completed) / len(completed)
        assert math.isclose(mean, result['metrics']['selectionScore'], abs_tol=1e-12), 'Corrupt selection mean'
        return finish_samples(directory, document, result, completed, rows)
    if kind == 'classification':
        assert all(row['prediction'] in (0, 1) for row in rows)
        assert result['metrics'] == _measure([target_by_id[row['id']] for row in rows], [row['prediction'] for row in rows]), 'Corrupt measured metrics'
        return finish_samples(directory, document, result, completed, rows)
    for fold in completed:
        batch = [row for row in rows if (row['repeat'], row['fold']) == (fold['repeat'], fold['fold'])]
        ari = adjusted_rand_score([target_by_id[row['id']] for row in batch], [row['prediction'] for row in batch])
        assert math.isclose(ari, fold['metrics']['adjustedRandIndex'], abs_tol=1e-12), 'Corrupt fold ARI'
    mean = sum(fold['metrics']['adjustedRandIndex'] for fold in completed) / len(completed)
    assert math.isclose(result['metrics']['adjustedRandIndex'], mean, abs_tol=1e-12), 'Corrupt measured metrics'
    finish_samples(directory, document, result, completed, rows)


def finish_samples(directory, document, result, completed, rows):
    metrics = json.loads((directory / 'metrics.json').read_text())
    assert result['status'] == 'completed' and result['promotionEligible'] is True
    assert metrics == result, 'Metrics and result differ'
    measured = [json.loads(line) for line in (directory / 'fold-results.jsonl').read_text().splitlines() if line]
    assert measured == completed, 'Fold measurements differ from checkpoint'
    with (directory / 'oof_predictions.csv').open(newline='') as stream:
        predictions = list(csv.DictReader(stream, delimiter=';'))
    assert len(predictions) == len(rows)
    for observed, expected in zip(predictions, rows):
        assert observed['id'] == expected['id']
        for key in ('repeat', 'fold', 'prediction'):
            assert int(observed[key]) == expected[key], 'OOF predictions differ from checkpoint'
        assert observed['score'] == str(expected['score']), 'OOF scores differ from checkpoint'
    assert result['source']['commit'] == document['source']['commit'] and result['source']['tree'] == document['source']['tree']
