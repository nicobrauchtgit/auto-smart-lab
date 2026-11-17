"""One frozen champion, development-only fit and held-back predictions.

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
from smartlab_trial.diagnostics import clustering, finite_vector
from sklearn.metrics import adjusted_rand_score
from task_samples import read_targets
from scipy.stats import bootstrap as paired_bootstrap


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(path):
    plan = json.loads(path.read_text())
    for source, expected in plan['originalHashes'].items():
        assert sha(source) == expected, 'Original confirmation data drifted'
    ids = plan['sealedIds']
    targets = read_targets(plan['targetsPath'], 'families' if plan.get('kind') == 'clustering' else 'binary')
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
    frame, truth, _ = load_samples({'kind': freeze.get('kind', 'classification'), 'execution': freeze.get('execution', 'inductive'),
                                  'sampleManifestPath': freeze['validationManifest']})
    assert [row['id'] for row in rows] == frame['id'].tolist(), 'Held-back prediction coverage differs'
    predicted = [int(row['prediction']) for row in rows]
    if freeze.get('kind') != 'clustering':
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


def cluster_interval(truth, predicted, seed):
    result = paired_bootstrap((np.asarray(truth), np.asarray(predicted)), adjusted_rand_score,
        paired=True, vectorized=False, n_resamples=2000, rng=np.random.default_rng(seed),
        confidence_level=.95, method='percentile')
    return {'confidence': .95, 'method': 'paired_percentile_bootstrap', 'replicates': 2000,
            'lower': float(result.confidence_interval.low), 'upper': float(result.confidence_interval.high)}


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
    is_clustering = freeze.get('kind') == 'clustering'
    counts = {str(label): truth.count(label) for label in (set(truth) if is_clustering else (0, 1))}
    expected = freeze['holdout']['perClass']
    assert counts == {key: value for key, value in expected.items() if value or not is_clustering}, 'Holdout class counts differ'
    assert len(truth) == freeze['holdout']['rows'], 'Holdout row count differs'
    assert result['metrics'] == (clustering(truth, predicted) if is_clustering else _measure(truth, predicted)), 'Confirmation metrics changed'
    assert result['interval'] == (cluster_interval if is_clustering else bootstrap)(truth, predicted, freeze['bootstrapSeed']), 'Confirmation interval changed'
    assert result['gap'] == freeze['cvMean'] - (result['metrics']['external']['adjustedRandIndex'] if is_clustering else result['metrics']['balancedAccuracy'])
    assert result['likelySelectionOverfit'] == (freeze['cvMean'] > result['interval']['upper'])
    assert result['status'] == 'completed' and result['fitCalls'] == 1 and result['validationRows'] == len(truth)
    return result


def run(directory):
    freeze = json.loads((directory / 'freeze.json').read_text())
    for path, expected in freeze['hashes'].items():
        assert sha(path) == expected, 'Confirmation input changed before fit'
    kind, execution = freeze.get('kind', 'classification'), freeze.get('execution', 'inductive')
    dev, labels, _ = load_samples({'kind': kind, 'execution': execution, 'sampleManifestPath': freeze['developmentManifest']})
    validation, truth, _ = load_samples({'kind': kind, 'execution': execution, 'sampleManifestPath': freeze['validationManifest']})
    assert not set(dev['id']).intersection(validation['id']), 'Confirmation overlaps development'
    expose_project(Path(freeze['sourceRoot']))
    pipeline = freeze['pipeline']
    context = {'parameters': pipeline.get('parameters', {}), 'seed': freeze['seed'], 'measurement': {'kind': kind, 'execution': execution, 'hasTargets': True}}
    estimator = _call_pipeline_factory(_factory(_load_module(Path(freeze['sourceRoot']), pipeline['module']), pipeline['factory']), context)
    if pipeline.get('estimatorParams'):
        estimator.set_params(**pipeline['estimatorParams'])
    seeded = _inject_random_states(estimator, freeze['seed'])
    events = EventWriter(directory, freeze['identity'])
    # Namespace environment clearing does not erase controller observability.
    events.identity = freeze['origin']
    scores = None
    with events.stage('confirmation_fit', developmentRows=len(dev)):
        if kind == 'clustering' and execution == 'batch':
            if hasattr(estimator, 'fit_predict'):
                raw = list(estimator.fit_predict(validation))
            else:
                estimator.fit(validation)
                raw = list(estimator.predict(validation))
        else:
            if kind == 'clustering':
                estimator.fit(dev)
            else:
                estimator.fit(dev, labels)
    with events.stage('confirmation_predict', validationRows=len(validation)):
        if kind != 'clustering' or execution != 'batch':
            raw = list(estimator.predict(validation))
        assert len(raw) == len(validation)
        if kind == 'clustering':
            values = finite_vector(raw, len(validation), 'Predictions')
            assert (values == np.floor(values)).all(), 'Invalid cluster predictions'
            raw = values.astype(int).tolist()
        else:
            assert all(value in (0, 1) for value in raw)
            scores, _ = score_observation(estimator, validation)
        predicted = [int(value) for value in raw]
    with (directory / 'predictions.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['id', 'prediction', 'score'])
        writer.writerows(zip(validation['id'], predicted, scores if scores is not None else [''] * len(predicted)))
    metrics = clustering(truth, predicted) if kind == 'clustering' else _measure(truth, predicted)
    interval = (cluster_interval if kind == 'clustering' else bootstrap)(truth, predicted, freeze['bootstrapSeed'])
    score = metrics['external']['adjustedRandIndex'] if kind == 'clustering' else metrics['balancedAccuracy']
    _atomic_json(directory / 'holdout-confirmation.json', {
        **{key: freeze[key] for key in ('taskId', 'experimentId', 'source', 'pipeline', 'holdout', 'readCount', 'identity', 'population', 'origin', 'cvMean', 'seed', 'bootstrapSeed')},
        'schemaVersion': 1, 'status': 'completed', 'advisoryOnly': True, 'fitCalls': 1,
        'developmentRows': len(dev), 'validationRows': len(validation), 'metrics': metrics, 'interval': interval,
        'gap': freeze['cvMean'] - score, 'likelySelectionOverfit': freeze['cvMean'] > interval['upper'],
        'seededParameters': seeded,
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
