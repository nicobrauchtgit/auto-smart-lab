"""Mock-only immutable refit fixture. Does not fit a model or contact a service."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys
import zipfile

root = Path(sys.argv[1])
project = Path(sys.argv[2])
sys.path.insert(0, str(project / 'agent/refit'))
from worker import data


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value))

source = root / 'source' / 'solutions'
source.mkdir(parents=True)
(source / 'tasks').mkdir()
(source / 'tasks' / 'fixture.py').write_text('def build(context):\n    return None\n')
(source / 'features.py').write_text('VALUE = 1\n')
(source / 'data').mkdir()
(source / 'data' / 'hidden.py').write_text('PRIVATE = 1\n')
(source / 'credentials.py').write_text('password = "never-upload"\n')
(source / 'notes.md').write_text('transcript fixture')
for args in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Mock source']]:
    subprocess.check_call(['git', '-C', str(source), *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip()
tree = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}']).decode().strip()
inputs = {key: str(root / key) for key in ['labelsPath', 'trainZip', 'testZip', 'devLabelsPath', 'devZip']}
train = ['train/a.0', 'train/b.1', 'train/c.0', 'train/d.1']
for key, ids in [('trainZip', train), ('devZip', train[:2]), ('testZip', ['test/a.x', 'test/b.x'])]:
    with zipfile.ZipFile(inputs[key], 'w') as archive:
        for name in ids:
            archive.writestr(name, 'mock corpus')
Path(inputs['labelsPath']).write_text(''.join(name + ';' + name[-1] + '\n' for name in train))
Path(inputs['devLabelsPath']).write_text('train/a.0;0\ntrain/b.1;1\n')
pipeline = {'module': 'solutions/tasks/fixture.py', 'factory': 'build', 'parameters': {'variant': sys.argv[3]}, 'estimatorParams': {}}
identity = hashlib.sha256(json.dumps({'taskId': 'fixture', 'commit': commit, 'pipeline': pipeline}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
evidence_path = root / 'evidence.json'
write(evidence_path, {'eligible': True, 'experimentId': 'mock-confirmation'})
framework = [sha(project / name) for name in ['agent/refit/worker.py', 'agent/training/python/runner.py', 'agent/refit/evidence.py', 'agent/training/python/task_samples.py']]
dependencies = json.dumps({'python': platform.python_version(), 'packages': sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions())}, sort_keys=True)
freeze = {'schemaVersion': 1, 'taskId': 'fixture', 'identity': identity, 'directory': str(root), 'sourceRoot': str(root / 'source'),
          'terminalPath': str(source / '.git' / 'smartlab-terminal' / (identity + '.json')), 'source': {'commit': commit, 'tree': tree},
          'pipeline': pipeline, 'chosenExperimentId': 'mock-confirmation', 'inputs': inputs, 'data': data(inputs),
          'environment': {'fingerprint': 'fixture-environment', 'runtimeDependencyHash': hashlib.sha256(dependencies.encode()).hexdigest(), 'frameworkHash': hashlib.sha256(json.dumps(framework, separators=(',', ':')).encode()).hexdigest()},
          'seed': 1, 'seedLineage': {'seed': 1}, 'evidence': [{'path': str(evidence_path), 'sha256': sha(evidence_path)}], 'origin': {'pipelineRunId': 'mock-run'}}
write(root / 'freeze.json', freeze)
write(freeze['terminalPath'], freeze)
(root / 'predictions.csv').write_text('id,prediction\ntest/a.x,0\ntest/b.x,1\n')
(root / 'prompt.md').write_text('Format:\n```\ntest/example.x;0\n```\n')
result = {'schemaVersion': 1, 'status': 'completed', 'identity': identity, 'freezeSha256': sha(root / 'freeze.json'),
          'trainRows': 4, 'testRows': 2, 'fitCalls': 1, 'trainIdsSha256': hashlib.sha256(json.dumps(train, separators=(',', ':')).encode()).hexdigest(),
          'data': freeze['data']['hashes'], 'artifacts': {'predictions.csv': sha(root / 'predictions.csv')}, 'modelSerialization': {'status': 'unavailable', 'errorType': 'MockNoModel'}, 'seededParameters': []}
for key in ['source', 'pipeline', 'environment', 'seed', 'seedLineage', 'evidence']:
    result[key] = freeze[key]
write(root / 'result.json', result)
print(json.dumps({'kind': 'terminal_refit_result', 'path': str(root / 'result.json'), 'sha256': sha(root / 'result.json')}))
