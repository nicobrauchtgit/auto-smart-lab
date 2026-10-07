"""Read-only frozen evidence checks and deterministic, allowlisted upload bundle."""
import csv
import hashlib
import importlib.metadata
import json
import platform
import re
import subprocess
import sys
import zipfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL, timeout=5)


def make(spec):
    artifact = spec['refitArtifact']
    result_path = Path(artifact['path']).resolve()
    directory = result_path.parent
    assert result_path.name == 'result.json' and artifact['kind'] == 'terminal_refit_result'
    assert sha(result_path) == artifact['sha256']
    freeze_path = directory / 'freeze.json'
    freeze = json.loads(freeze_path.read_text())
    result = json.loads(result_path.read_text())
    assert freeze['schemaVersion'] == 1 and result['schemaVersion'] == 1
    assert freeze['taskId'] == spec['taskId'] and result['status'] == 'completed'
    assert result['identity'] == freeze['identity']
    assert result['freezeSha256'] == sha(freeze_path) == sha(freeze['terminalPath'])
    assert Path(freeze['directory']).resolve() == directory
    assert Path(freeze['sourceRoot']).resolve() == directory / 'source'
    candidate = {'taskId': spec['taskId'], 'commit': freeze['source']['commit'], 'pipeline': {
        'module': freeze['pipeline']['module'], 'factory': freeze['pipeline']['factory'],
        'parameters': freeze['pipeline'].get('parameters'), 'estimatorParams': freeze['pipeline'].get('estimatorParams', {})}}
    identity = hashlib.sha256(json.dumps(candidate, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    assert identity == freeze['identity']
    assert result['fitCalls'] == 1 and result['trainRows'] == freeze['data']['trainRows'] and result['testRows'] == freeze['data']['testRows']
    assert result['trainIdsSha256'] == hashlib.sha256(json.dumps(freeze['data']['trainIds'], separators=(',', ':')).encode()).hexdigest()
    for key in ['source', 'pipeline', 'environment', 'seed', 'seedLineage', 'evidence']:
        assert result[key] == freeze[key]
    assert result['data'] == freeze['data']['hashes']
    assert freeze['environment']['fingerprint'] == spec['environmentFingerprint']
    dependencies = json.dumps({'python': platform.python_version(), 'packages': sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions())}, sort_keys=True)
    assert hashlib.sha256(dependencies.encode()).hexdigest() == freeze['environment']['runtimeDependencyHash']
    project = Path(spec['projectRoot'])
    framework_files = ['agent/refit/worker.py', 'agent/training/python/runner.py', 'agent/refit/evidence.py']
    hashes = [sha(project / name) for name in framework_files]
    assert hashlib.sha256(json.dumps(hashes, separators=(',', ':')).encode()).hexdigest() == freeze['environment']['frameworkHash']
    assert freeze['evidence'] and freeze['chosenExperimentId']
    for evidence in freeze['evidence']:
        assert sha(evidence['path']) == evidence['sha256']
    for key, checksum in freeze['data']['hashes'].items():
        assert sha(freeze['inputs'][key]) == checksum
    # Reuse the harness's format, exact data coverage/CRC and result validation, never fit.
    worker = project / 'agent/refit/worker.py'
    inspected = json.loads(subprocess.check_output([sys.executable, str(worker), '--inspect-json', json.dumps(freeze['inputs'])], stderr=subprocess.DEVNULL, timeout=30))
    assert inspected == freeze['data']
    subprocess.check_output([sys.executable, str(worker), '--directory', str(directory), '--validate'], stderr=subprocess.DEVNULL, timeout=30)
    csv_path = directory / 'predictions.csv'
    assert sha(csv_path) == result['artifacts']['predictions.csv']
    with csv_path.open(newline='') as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == ['id', 'prediction']
        rows = list(reader)
    assert sorted(row['id'] for row in rows) == freeze['data']['testIds']
    assert all(row['prediction'] in ('0', '1') and not row.get(None) for row in rows)
    # This adapter supports only tasks whose documented example establishes this format.
    prompt = Path(spec['taskPromptPath']).read_text()
    examples = re.findall(r'^([^\s;]+\.x);[01]$', prompt, re.M)
    assert examples and all('/' in name for name in examples)
    expected_prefixes = {name.rsplit('/', 1)[0] for name in examples}
    assert len(expected_prefixes) == 1
    assert all(row['id'].rsplit('/', 1)[0] in expected_prefixes and not re.search(r'[;\r\n]', row['id']) for row in rows)
    source = directory / 'source' / 'solutions'
    common = Path(git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
    assert Path(freeze['terminalPath']).resolve() == common / 'smartlab-terminal' / (freeze['identity'] + '.json')
    assert git(source, 'rev-parse', 'HEAD').decode().strip() == freeze['source']['commit']
    assert git(source, 'rev-parse', 'HEAD^{tree}').decode().strip() == freeze['source']['tree']
    assert not git(source, 'status', '--porcelain', '--untracked-files=all').strip()
    entries = git(source, 'ls-tree', '-rz', 'HEAD').split(b'\0')
    files = []
    denied = {'data', 'knowledge', 'transcripts', 'runs', 'secrets', 'credentials', '__pycache__', '.git', '.venv'}
    for entry in entries:
        if not entry:
            continue
        info, name = entry.split(b'\t', 1)
        mode, kind, blob = info.decode().split()
        path = Path(name.decode())
        assert mode in ('100644', '100755') and kind == 'blob', 'Symlink/submodule source rejected'
        # A small source allowlist, not a broad whole-project exclusion list.
        if path.suffix != '.py' or any(part.lower() in denied or part.startswith('.') for part in path.parts):
            continue
        if re.search(r'(secret|credential|cookie|token|transcript)', str(path), re.I):
            continue
        data = git(source, 'show', f'HEAD:{path.as_posix()}')
        assert (source / path).read_bytes() == data
        # Refuse common embedded credentials rather than uploading them.
        assert not re.search(rb'(?i)(api[_-]?key|password|secret|access[_-]?token)\s*=\s*[\x22\x27][^\x22\x27]+[\x22\x27]', data)
        files.append((path.as_posix(), data))
    entrypoint = freeze['pipeline']['module']
    if entrypoint.startswith('solutions/'):
        entrypoint = entrypoint[len('solutions/'):]
    assert files and entrypoint in [name for name, _ in files]
    if spec.get('validateOnly'):
        return {'valid': True, 'candidateId': freeze['identity']}
    out = Path(spec['outputDirectory'])
    out.mkdir(parents=True, exist_ok=True)
    output = ''.join(row['id'] + ';' + row['prediction'] + '\n' for row in sorted(rows, key=lambda row: row['id'])).encode()
    (out / 'output.csv').write_bytes(output)
    with zipfile.ZipFile(out / 'source.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files):
            info = zipfile.ZipInfo('source/' + name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    assert all((out / name).stat().st_size <= 2 * 1024 * 1024 for name in ('output.csv', 'source.zip'))
    return {'version': 1, 'taskId': spec['taskId'], 'candidateId': freeze['identity'], 'refitSha256': artifact['sha256'], 'freezeSha256': sha(freeze_path), 'source': freeze['source'], 'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files)], 'artifacts': {name: sha(out / name) for name in ('output.csv', 'source.zip')}}


if __name__ == '__main__':
    try:
        print(json.dumps(make(json.loads(sys.stdin.read())), sort_keys=True))
    except Exception:
        # No provider errors, credentials, source content or label values in diagnostics.
        print('Frozen submission bundle validation failed', file=sys.stderr)
        sys.exit(1)
