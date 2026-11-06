"""Write the official hand-over files for a validated terminal refit. Never fits.

output.csv is the official format: no header, `id;prediction`, sorted by id. It
is refused unless its IDs equal the frozen test IDs exactly and every prediction
fits the declared domain. source.zip holds the frozen solution code.
"""
import csv
import hashlib
import json
import platform
import re
import sys
import zipfile
from pathlib import Path


def deliver(directory, output, metadata):
    directory, output = Path(directory), Path(output)
    freeze = json.loads((directory / 'freeze.json').read_text())
    with (directory / 'predictions.csv').open(newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != ['id', 'prediction']:
            raise ValueError(f'unexpected predictions.csv columns: {reader.fieldnames}')
        rows = list(reader)
    ids = [row['id'] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate prediction ids')
    expected = set(freeze['data']['testIds'])
    if set(ids) != expected:
        raise ValueError(f'ids differ from the test set: {len(expected - set(ids))} missing, {len(set(ids) - expected)} extra')
    domain = freeze['inputs'].get('task', {}).get('predictions', 'binary')
    pattern = r'[01]' if domain == 'binary' else r'-?\d+'
    for row in rows:
        if not re.fullmatch(pattern, row['prediction'] or ''):
            raise ValueError(f'prediction outside the {domain} domain for {row["id"]}')

    output.mkdir(parents=True, exist_ok=True)
    data = ''.join(f"{row['id']};{row['prediction']}\n" for row in sorted(rows, key=lambda row: row['id'])).encode()
    (output / 'output.csv').write_bytes(data)
    source_root = Path(freeze['sourceRoot'])
    with zipfile.ZipFile(output / 'source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source_root.rglob('*')):
            parts = path.relative_to(source_root).parts
            if path.is_file() and '.git' not in parts and '__pycache__' not in parts:
                archive.write(path, Path(*parts))
    manifest = {
        **metadata,
        'arm': 'harness',
        'task': freeze['taskId'],
        'python': platform.python_version(),
        'identity': freeze['identity'],
        'experiment': freeze['chosenExperimentId'],
        'solutionCommit': freeze['source']['commit'],
        'lines': len(rows),
        'sha256': hashlib.sha256(data).hexdigest(),
        'files': ['output.csv', 'source.zip', 'manifest.json'],
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    print(json.dumps(deliver(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))))
