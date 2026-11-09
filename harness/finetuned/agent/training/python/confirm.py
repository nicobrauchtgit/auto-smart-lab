"""One frozen champion, development-only fit, held-back predictions and canary.

Preparation runs in the trusted controller. The fitting process receives only
development data and a sealed-only validation archive, never original full labels.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import zipfile

import numpy as np
from smartlab_trial.agent_code import expose_project, _load_module, _factory, _call_pipeline_factory, _inject_random_states
from smartlab_trial.artifacts import _atomic_json, EventWriter
from smartlab_trial.measurement import load_samples
from smartlab_trial.metrics import _measure, score_observation
from smartlab_trial.id_leakage import check as check_id_leakage


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(path):
    plan = json.loads(path.read_text())
    for source, expected in plan['originalHashes'].items():
        assert sha(source) == expected, 'Original confirmation data drifted'
    ids = plan['sealedIds']
    targets = {}
    for line in Path(plan['targetsPath']).read_text().splitlines():
        if line.strip():
            name, value = line.rsplit(';', 1)
            assert name not in targets and value in ('0', '1'), 'Invalid original targets'
            targets[name] = int(value)
    assert len(set(ids)) == len(ids) and set(ids) <= set(targets)
    directory = path.parent
    archive_path = directory / 'sealed.zip'
    with zipfile.ZipFile(plan['trainZip']) as source, zipfile.ZipFile(archive_path, 'w') as destination:
        for name in ids:
            destination.writestr(name, source.read(name))
    manifest = directory / 'sealed-samples.json'
    _atomic_json(manifest, {'schemaVersion': 1, 'samples': [
        {'id': name, 'input': {'archive': str(archive_path), 'member': name}, 'target': targets[name]} for name in ids]})
    for source, expected in plan['originalHashes'].items():
        assert sha(source) == expected, 'Original confirmation data changed during preparation'


def observations(directory, freeze):
    with (directory / 'predictions.csv').open(newline='') as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == ['id', 'prediction', 'score']
        rows = list(reader)
    frame, truth, _ = load_samples({'kind': 'classification', 'execution': 'inductive',
                                  'sampleManifestPath': freeze['validationManifest']})
    assert [row['id'] for row in rows] == frame['id'].tolist(), 'Held-back prediction coverage differs'
    predicted = [int(row['prediction']) for row in rows]
    assert all(row['prediction'] in ('0', '1') for row in rows), 'Invalid held-back predictions'
    return truth, predicted


def bootstrap(truth, predicted, seed):
    truth, predicted = np.asarray(truth), np.asarray(predicted)
    generator = np.random.default_rng(seed)
    strata = [np.flatnonzero(truth == label) for label in (0, 1)]
    assert all(len(indices) for indices in strata), 'Confirmation needs both classes'
    values = []
    for _ in range(2000):
        values.append(float(np.mean([np.mean(predicted[draw] == label)
                                    for label, indices in enumerate(strata)
                                    for draw in [generator.choice(indices, len(indices), replace=True)]])))
    lower, upper = np.quantile(values, [0.025, 0.975])
    return {'confidence': .95, 'method': 'stratified_percentile_bootstrap', 'replicates': 2000,
            'lower': float(lower), 'upper': float(upper)}


def validate(directory):
    freeze = json.loads((directory / 'freeze.json').read_text())
    result = json.loads((directory / 'holdout-confirmation.json').read_text())
    assert result['freezeSha256'] == sha(directory / 'freeze.json'), 'Confirmation freeze changed'
    for key in ('taskId', 'experimentId', 'source', 'pipeline', 'holdout', 'readCount', 'identity', 'population', 'origin', 'cvMean', 'seed', 'bootstrapSeed'):
        assert result[key] == freeze[key], 'Confirmation identity changed'
    for path, expected in freeze['hashes'].items():
        assert sha(path) == expected, 'Confirmation input changed'
    assert result['predictionsSha256'] == sha(directory / 'predictions.csv'), 'Confirmation predictions changed'
    truth, predicted = observations(directory, freeze)
    assert {str(label): truth.count(label) for label in (0, 1)} == freeze['holdout']['perClass'], 'Holdout class counts differ'
    assert len(truth) == freeze['holdout']['rows'], 'Holdout row count differs'
    assert result['metrics'] == _measure(truth, predicted), 'Confirmation metrics changed'
    assert result['interval'] == bootstrap(truth, predicted, freeze['bootstrapSeed']), 'Confirmation interval changed'
    assert result['gap'] == freeze['cvMean'] - result['metrics']['balancedAccuracy']
    assert result['likelySelectionOverfit'] == (freeze['cvMean'] > result['interval']['upper'])
    assert result['status'] == 'completed' and result['fitCalls'] == 1 and result['validationRows'] == len(truth)
    return result


def run(directory):
    freeze = json.loads((directory / 'freeze.json').read_text())
    for path, expected in freeze['hashes'].items():
        assert sha(path) == expected, 'Confirmation input changed before fit'
    dev, labels, _ = load_samples({'kind': 'classification', 'execution': 'inductive', 'sampleManifestPath': freeze['developmentManifest']})
    validation, truth, _ = load_samples({'kind': 'classification', 'execution': 'inductive', 'sampleManifestPath': freeze['validationManifest']})
    assert not set(dev['id']).intersection(validation['id']), 'Confirmation overlaps development'
    expose_project(Path(freeze['sourceRoot']))
    pipeline = freeze['pipeline']
    context = {'parameters': pipeline.get('parameters', {}), 'seed': freeze['seed'], 'measurement': {'kind': 'classification', 'execution': 'inductive', 'hasTargets': True}}
    estimator = _call_pipeline_factory(_factory(_load_module(Path(freeze['sourceRoot']), pipeline['module']), pipeline['factory']), context)
    if pipeline.get('estimatorParams'):
        estimator.set_params(**pipeline['estimatorParams'])
    seeded = _inject_random_states(estimator, freeze['seed'])
    events = EventWriter(directory, freeze['identity'])
    # Namespace environment clearing does not erase controller observability.
    events.identity = freeze['origin']
    with events.stage('confirmation_fit', developmentRows=len(dev)):
        estimator.fit(dev, labels)
    with events.stage('confirmation_predict', validationRows=len(validation)):
        raw = list(estimator.predict(validation))
        assert len(raw) == len(validation) and all(value in (0, 1) for value in raw)
        predicted = [int(value) for value in raw]
        scores, _ = score_observation(estimator, validation)
        leakage = check_id_leakage(estimator, validation, predicted, scores)
    with (directory / 'predictions.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['id', 'prediction', 'score'])
        writer.writerows(zip(validation['id'], predicted, scores if scores is not None else [''] * len(predicted)))
    metrics = _measure(truth, predicted)
    interval = bootstrap(truth, predicted, freeze['bootstrapSeed'])
    _atomic_json(directory / 'holdout-confirmation.json', {
        **{key: freeze[key] for key in ('taskId', 'experimentId', 'source', 'pipeline', 'holdout', 'readCount', 'identity', 'population', 'origin', 'cvMean', 'seed', 'bootstrapSeed')},
        'schemaVersion': 1, 'status': 'completed', 'advisoryOnly': True, 'fitCalls': 1,
        'developmentRows': len(dev), 'validationRows': len(validation), 'metrics': metrics, 'interval': interval,
        'gap': freeze['cvMean'] - metrics['balancedAccuracy'], 'likelySelectionOverfit': freeze['cvMean'] > interval['upper'],
        'seededParameters': seeded, 'idLeakage': leakage,
        'freezeSha256': sha(directory / 'freeze.json'), 'predictionsSha256': sha(directory / 'predictions.csv')})
    validate(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', type=Path)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        prepare(args.prepare)
    elif args.validate:
        validate(args.directory)
    else:
        run(args.directory)
