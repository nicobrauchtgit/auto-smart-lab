"""Deterministic terminal fit. No CV, selection, or sealed measurement.

Every task fits opaque `{archive, member}` descriptors the agent's code reads
itself, following the measured execution: inductive tasks fit all training
samples (binary classification with all labels, sealed rows included) and
predict the test samples; batch tasks fit and predict the test batch. Only
classification passes targets to fit. Freezes from the retired decoded-text
frame (no `kind` in their inputs) remain verifiable through the legacy path.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import re
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training' / 'python'))
from smartlab_trial.agent_code import expose_project, _load_module, _factory, _call_pipeline_factory, _inject_random_states
from smartlab_trial.artifacts import _atomic_json, EventWriter
from smartlab_eval import load_labelled, load_corpus, load_labels
from task_samples import archive_ids, read_targets, sample_descriptors


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ids(path, labels_path=None):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, 'Corrupt archive'
        values = [e.filename for e in archive.infolist() if not e.is_dir()]
        assert values and len(set(values)) == len(values), 'Empty or duplicate archive IDs'
        # Official training ZIPs may embed the same labels file beside the
        # sample members. Exclude only that exact, byte-verified sidecar.
        if labels_path is not None:
            sidecar = Path(labels_path).name
            if sidecar in values:
                assert archive.read(sidecar) == Path(labels_path).read_bytes(), 'Embedded training labels drifted'
                values.remove(sidecar)
    assert values, 'Empty archive IDs'
    return values


def sample_data(inputs):
    """Original sample identity for sample tasks; the dev manifest must be a subset with identical content."""
    targets_path = inputs.get('targetsPath')
    source = inputs['task'].get('source', 'zip_members')
    train = [sample['id'] for sample in sample_descriptors(inputs['trainZip'], source, targets_path)]
    test = [sample['id'] for sample in sample_descriptors(inputs['testZip'], source)]
    assert not set(train).intersection(test), 'Train/test overlap'
    targets = read_targets(targets_path, inputs['task']['targets']) if targets_path else None
    assert targets is None or set(targets) == set(train), 'Original archive/target coverage mismatch'
    if 'devManifest' not in inputs:
        return {'trainRows': len(train), 'testRows': len(test)}
    samples = json.loads(Path(inputs['devManifest']).read_text())['samples']
    dev = [sample['id'] for sample in samples]
    assert dev and len(set(dev)) == len(dev) and set(dev) <= set(train), 'Development manifest is not a subset of training samples'
    expected = {sample['id']: sample['input'] for sample in sample_descriptors(inputs['devZip'], source)}
    assert all(sample['input'] == expected.get(sample['id']) for sample in samples), 'Development descriptors drifted'
    if targets is not None:
        assert all(str(targets[sample['id']]) == str(sample.get('target')) for sample in samples), 'Development targets drifted'
    assert set(expected) == set(dev), 'Development sample coverage mismatch'
    if source == 'pcap_tcp_connections':
        assert sha(inputs['trainZip']) == sha(inputs['devZip']), 'Original capture differs from measured development capture'
    else:
        with zipfile.ZipFile(inputs['trainZip']) as original, zipfile.ZipFile(inputs['devZip']) as measured:
            assert all(original.read(name) == measured.read(name) for name in dev), 'Original training content differs from measured development archive'
    keys = ['trainZip', 'testZip', 'devZip', 'devManifest', *(['targetsPath'] if targets_path else [])]
    return {'trainIds': sorted(train), 'testIds': sorted(test), 'trainRows': len(train),
            'developmentRows': len(dev), 'sealedRows': len(train) - len(dev), 'testRows': len(test),
            'hashes': {key: sha(inputs[key]) for key in keys}}


def data(inputs):
    if inputs.get('kind') == 'samples':
        return sample_data(inputs)
    lines = [line.strip() for line in Path(inputs['labelsPath']).read_text().splitlines() if line.strip()]
    labels = load_labels(inputs['labelsPath'])
    assert len(lines) == len(labels) and labels, 'Duplicate or empty labels'
    train = ids(inputs['trainZip'], inputs['labelsPath'])
    test = ids(inputs['testZip'])
    assert set(train) == set(labels), 'Original archive/label coverage mismatch'
    assert not set(train).intersection(test), 'Train/test overlap'
    assert all(name.endswith('.x') for name in test), 'Test archive must have neutral IDs'
    if 'devLabelsPath' not in inputs:
        return {'trainRows': len(train), 'testRows': len(test)}
    dev = load_labels(inputs['devLabelsPath'])
    assert dev and all(labels.get(name) == label for name, label in dev.items()), 'Development labels drifted'
    assert set(ids(inputs['devZip'])) == set(dev), 'Development archive coverage mismatch'
    with zipfile.ZipFile(inputs['trainZip']) as original, zipfile.ZipFile(inputs['devZip']) as measured:
        assert all(original.read(name) == measured.read(name) for name in dev), 'Original training content differs from measured development archive'
    return {'trainIds': sorted(train), 'testIds': sorted(test), 'trainRows': len(train),
            'developmentRows': len(dev), 'sealedRows': len(train) - len(dev), 'testRows': len(test),
            'hashes': {key: sha(inputs[key]) for key in ('labelsPath', 'trainZip', 'testZip', 'devLabelsPath', 'devZip')}}


def validate(directory, freeze):
    result = json.loads((directory / 'result.json').read_text())
    assert result['schemaVersion'] == 1 and result['status'] == 'completed'
    assert result['identity'] == freeze['identity'] and result['freezeSha256'] == sha(directory / 'freeze.json')
    assert result['trainRows'] == freeze['data']['trainRows'] and result['fitCalls'] == 1
    assert result['trainIdsSha256'] == hashlib.sha256(json.dumps(freeze['data']['trainIds'], separators=(',', ':')).encode()).hexdigest()
    assert result['testRows'] == freeze['data']['testRows']
    for key, expected in [('source', freeze['source']), ('pipeline', freeze['pipeline']), ('environment', freeze['environment']), ('seed', freeze['seed']), ('seedLineage', freeze['seedLineage']), ('evidence', freeze['evidence']), ('data', freeze['data']['hashes'])]:
        assert result[key] == expected, 'Result metadata differs from freeze'
    assert result['artifacts']['predictions.csv'] == sha(directory / 'predictions.csv'), 'Artifact checksum mismatch'
    if result['modelSerialization']['status'] == 'available':
        assert result['artifacts']['model.pkl'] == sha(directory / 'model.pkl'), 'Artifact checksum mismatch'
    else:
        assert result['modelSerialization']['status'] == 'unavailable' and result['modelSerialization']['errorType']
        assert 'model.pkl' not in result['artifacts']
    with (directory / 'predictions.csv').open(newline='') as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == ['id', 'prediction']
        rows = list(reader)
    assert len(rows) == freeze['data']['testRows']
    assert sorted(row['id'] for row in rows) == freeze['data']['testIds'], 'Prediction coverage mismatch'
    domain = freeze['inputs'].get('task', {}).get('predictions', 'binary')
    valid = (lambda value: value in ('0', '1')) if domain == 'binary' else (lambda value: re.fullmatch(r'-?\d+', value) is not None)
    assert all(valid(row['prediction']) for row in rows), 'Invalid prediction domain'
    return result


def sample_frame(archive, ids, source='zip_members', sidecar=None):
    import pandas as pd
    descriptors = {sample['id']: sample['input'] for sample in sample_descriptors(archive, source, sidecar)}
    assert set(ids) == set(descriptors), 'Sample frame coverage mismatch'
    return pd.DataFrame([{'id': row_id, 'input': descriptors[row_id]} for row_id in ids])


def fit_samples(estimator, freeze, events):
    """Mirror the measured execution exactly; only classification fits with targets."""
    task, inputs = freeze['inputs']['task'], freeze['inputs']
    source = task.get('source', 'zip_members')
    train = sample_frame(inputs['trainZip'], freeze['data']['trainIds'], source, inputs.get('targetsPath'))
    test = sample_frame(inputs['testZip'], freeze['data']['testIds'], source)
    if task['kind'] == 'classification':
        targets = read_targets(inputs['targetsPath'], 'binary')
        with events.stage('terminal_fit', fitRows=len(train), execution='inductive'):
            estimator.fit(train, [targets[row_id] for row_id in freeze['data']['trainIds']])
        with events.stage('terminal_predict', testRows=len(test)):
            predicted = [int(value) for value in estimator.predict(test)]
        assert len(predicted) == len(test) and all(value in (0, 1) for value in predicted), 'Invalid predictions'
        return predicted, len(train), len(test)
    if task['execution'] == 'batch':
        with events.stage('terminal_fit', fitRows=len(test), execution='batch'):
            if callable(getattr(estimator, 'fit_predict', None)):
                predicted = estimator.fit_predict(test)
            else:
                estimator.fit(test)
                predicted = estimator.predict(test)
        fit_rows = len(test)
    else:
        with events.stage('terminal_fit', fitRows=len(train), execution='inductive'):
            estimator.fit(train)
        with events.stage('terminal_predict', testRows=len(test)):
            predicted = estimator.predict(test)
        fit_rows = len(train)
    values = [float(value) for value in predicted]
    assert len(values) == len(test) and all(value == int(value) for value in values), 'Predictions must be integer labels'
    values = [int(value) for value in values]
    if task['kind'] == 'anomaly_detection':
        # The submitted domain is 1 for anomalies, whatever label the pipeline uses.
        values = [1 if value == task['anomaly']['anomalyLabel'] else 0 for value in values]
    return values, fit_rows, len(test)


def fit(directory, freeze):
    # The atomic terminal marker and immutable freeze are already durable here.
    assert sha(freeze['terminalPath']) == sha(directory / 'freeze.json'), 'Terminal marker differs'
    assert data(freeze['inputs']) == freeze['data'], 'Data drift after freeze'
    source = Path(freeze['sourceRoot'])
    expose_project(source)
    pipeline = freeze['pipeline']
    context = {'parameters': pipeline.get('parameters'), 'seed': freeze['seed']}
    if freeze['inputs'].get('kind') == 'samples':
        # The factory sees the same controller measurement context as in its measured trials.
        context['measurement'] = freeze['inputs']['task']['measurement']
    estimator = _call_pipeline_factory(_factory(_load_module(source, pipeline['module']), pipeline['factory']), context)
    if pipeline.get('estimatorParams'):
        estimator.set_params(**pipeline['estimatorParams'])
    seeded = _inject_random_states(estimator, freeze['seed'])
    events = EventWriter(directory, freeze['identity'])
    if freeze['inputs'].get('kind') == 'samples':
        predicted, fit_rows, test_rows = fit_samples(estimator, freeze, events)
    else:
        frame, labels = load_labelled(freeze['inputs']['trainZip'], freeze['inputs']['labelsPath'], freeze['data']['trainIds'])
        test = load_corpus(freeze['inputs']['testZip'], freeze['data']['testIds'])
        with events.stage('terminal_fit', trainRows=len(labels)):
            estimator.fit(frame, labels)
        with events.stage('terminal_predict', testRows=len(test)):
            predicted = list(estimator.predict(test))
        assert len(predicted) == len(test) and all(value in (0, 1) for value in predicted), 'Invalid predictions'
        fit_rows, test_rows = len(labels), len(test)
    # Completion is committed last. Interrupted fits never count as complete.
    with tempfile.NamedTemporaryFile(dir=directory, delete=False, mode='w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['id', 'prediction'])
        writer.writerows(zip(freeze['data']['testIds'], (int(v) for v in predicted)))
        stream.flush(); os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, directory / 'predictions.csv')
    import cloudpickle
    model_serialization = {'status': 'available'}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as stream:
            temporary = stream.name
            cloudpickle.dump(estimator, stream)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, directory / 'model.pkl')
    except Exception as error:
        # Serialization is useful but does not constrain agent estimator design.
        if temporary:
            Path(temporary).unlink(missing_ok=True)
        (directory / 'model.pkl').unlink(missing_ok=True)
        model_serialization = {'status': 'unavailable', 'errorType': type(error).__name__}
        events.emit('model_serialization_unavailable', errorType=type(error).__name__)
    _atomic_json(directory / 'result.json', {
        'schemaVersion': 1, 'status': 'completed', 'identity': freeze['identity'],
        'freezeSha256': sha(directory / 'freeze.json'), 'trainRows': freeze['data']['trainRows'], 'testRows': test_rows,
        'fitRows': fit_rows, 'fitCalls': 1, 'trainIdsSha256': hashlib.sha256(json.dumps(freeze['data']['trainIds'], separators=(',', ':')).encode()).hexdigest(),
        'seededParameters': seeded, 'source': freeze['source'], 'pipeline': pipeline,
        'environment': freeze['environment'], 'seed': freeze['seed'], 'seedLineage': freeze['seedLineage'],
        'evidence': freeze['evidence'], 'data': freeze['data']['hashes'],
        'modelSerialization': model_serialization,
        'artifacts': {name: sha(directory / name) for name in ('predictions.csv', 'model.pkl') if name == 'predictions.csv' or model_serialization['status'] == 'available'},
    })
    validate(directory, freeze)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path)
    parser.add_argument('--inspect-json')
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    if args.evidence:
        from evidence import validate as validate_evidence
        validate_evidence(args.evidence)
    elif args.inspect_json:
        print(json.dumps(data(json.loads(args.inspect_json))))
    elif args.data:
        print(json.dumps(data(json.loads(args.data.read_text()))))
    else:
        freeze = json.loads((args.directory / 'freeze.json').read_text())
        if args.validate:
            validate(args.directory, freeze)
        else:
            fit(args.directory, freeze)
