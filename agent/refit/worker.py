"""Deterministic terminal fit. No CV, selection, or sealed measurement."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training' / 'python'))
from smartlab_trial.agent_code import expose_project, _load_module, _factory, _call_pipeline_factory, _inject_random_states
from smartlab_trial.artifacts import _atomic_json, EventWriter
from smartlab_eval import load_labelled, load_corpus, load_labels


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


def data(inputs):
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
    assert all(row['prediction'] in ('0', '1') for row in rows), 'Invalid prediction domain'
    return result


def fit(directory, freeze):
    # The atomic terminal marker and immutable freeze are already durable here.
    assert sha(freeze['terminalPath']) == sha(directory / 'freeze.json'), 'Terminal marker differs'
    assert data(freeze['inputs']) == freeze['data'], 'Data drift after freeze'
    source = Path(freeze['sourceRoot'])
    expose_project(source)
    pipeline = freeze['pipeline']
    estimator = _call_pipeline_factory(_factory(_load_module(source, pipeline['module']), pipeline['factory']),
                                      {'parameters': pipeline.get('parameters'), 'seed': freeze['seed']})
    if pipeline.get('estimatorParams'):
        estimator.set_params(**pipeline['estimatorParams'])
    seeded = _inject_random_states(estimator, freeze['seed'])
    frame, labels = load_labelled(freeze['inputs']['trainZip'], freeze['inputs']['labelsPath'], freeze['data']['trainIds'])
    test = load_corpus(freeze['inputs']['testZip'], freeze['data']['testIds'])
    events = EventWriter(directory, freeze['identity'])
    with events.stage('terminal_fit', trainRows=len(labels)):
        estimator.fit(frame, labels)
    with events.stage('terminal_predict', testRows=len(test)):
        predicted = list(estimator.predict(test))
    assert len(predicted) == len(test) and all(value in (0, 1) for value in predicted), 'Invalid predictions'
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
        'freezeSha256': sha(directory / 'freeze.json'), 'trainRows': len(labels), 'testRows': len(test),
        'fitCalls': 1, 'trainIdsSha256': hashlib.sha256(json.dumps(freeze['data']['trainIds'], separators=(',', ':')).encode()).hexdigest(),
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
