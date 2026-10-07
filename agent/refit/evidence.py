"""Check original development measurements without fitting or sealed labels."""
import csv
import json
from pathlib import Path

from smartlab_eval import load_labels
from smartlab_trial.invocation import parse_invocation
from smartlab_trial.recovery import load_checkpoint, persisted_folds, validate_single
from smartlab_trial.metrics import _measure


def validate(directory):
    document = json.loads((directory / 'invocation.json').read_text())
    invocation = parse_invocation(document)
    assert not invocation.search and invocation.scope.kind == 'promotion'
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
