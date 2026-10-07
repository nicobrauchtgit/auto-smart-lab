"""Terminal data and artifact boundaries, using local deterministic fixtures."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

REFIT = Path(__file__).resolve().parents[2] / 'refit' / 'worker.py'
spec = importlib.util.spec_from_file_location('terminal_worker_test', REFIT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TerminalRefitTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.inputs = {key: str(self.root / key) for key in ('labelsPath', 'trainZip', 'testZip', 'devLabelsPath', 'devZip')}
        self.train = ['train/a.0', 'train/b.1', 'train/c.0', 'train/d.1']
        self.test = ['test/a.x', 'test/b.x']
        for key, ids in [('trainZip', self.train), ('devZip', self.train[:2]), ('testZip', self.test)]:
            self.archive(key, ids)
        Path(self.inputs['labelsPath']).write_text(''.join(f'{name};{i % 2}\n' for i, name in enumerate(self.train)))
        Path(self.inputs['devLabelsPath']).write_text('train/a.0;0\ntrain/b.1;1\n')

    def archive(self, key, ids):
        with zipfile.ZipFile(self.inputs[key], 'w') as archive:
            for name in ids:
                archive.writestr(name, 'fixture body')

    def test_complete_original_coverage_and_sealed_complement(self):
        self.assertEqual(worker.data(self.inputs)['sealedRows'], 2)
        self.archive('trainZip', self.train[:-1])
        with self.assertRaisesRegex(AssertionError, 'coverage'):
            worker.data(self.inputs)

    def test_duplicate_labels_are_refused(self):
        path = Path(self.inputs['labelsPath'])
        path.write_text(path.read_text() + 'train/a.0;0\n')
        with self.assertRaisesRegex(AssertionError, 'Duplicate'):
            worker.data(self.inputs)

    def test_original_archive_accepts_only_its_verified_labels_sidecar(self):
        labels = Path(self.inputs['labelsPath'])
        with zipfile.ZipFile(self.inputs['trainZip'], 'a') as archive:
            archive.writestr(labels.name, labels.read_bytes())
        self.assertEqual(worker.data(self.inputs)['trainRows'], len(self.train))
        self.assertEqual(worker.data(self.inputs)['sealedRows'], 2)
        with zipfile.ZipFile(self.inputs['trainZip'], 'a') as archive:
            archive.writestr('unexpected.labels', labels.read_bytes())
        with self.assertRaisesRegex(AssertionError, 'coverage'):
            worker.data(self.inputs)

    def test_embedded_original_labels_must_match_external_labels(self):
        with zipfile.ZipFile(self.inputs['trainZip'], 'a') as archive:
            archive.writestr(Path(self.inputs['labelsPath']).name, 'train/a.0;1\n')
        with self.assertRaisesRegex(AssertionError, 'Embedded training labels drifted'):
            worker.data(self.inputs)

    def test_duplicate_test_ids_are_refused(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.archive('testZip', ['test/a.x', 'test/a.x'])
        with self.assertRaisesRegex(AssertionError, 'duplicate'):
            worker.data(self.inputs)

    def test_labelled_test_ids_and_train_test_overlap_are_refused(self):
        self.archive('testZip', ['test/a.0'])
        with self.assertRaisesRegex(AssertionError, 'neutral'):
            worker.data(self.inputs)
        self.archive('testZip', ['train/a.0'])
        with self.assertRaisesRegex(AssertionError, 'overlap'):
            worker.data(self.inputs)

    def test_development_label_drift_is_refused(self):
        Path(self.inputs['devLabelsPath']).write_text('train/a.0;1\ntrain/b.1;1\n')
        with self.assertRaisesRegex(AssertionError, 'drifted'):
            worker.data(self.inputs)

    def fit(self, serializable=True):
        source = self.root / 'source'
        (source / 'solutions').mkdir(parents=True)
        module = source / 'solutions' / 'pipeline.py'
        module.write_text('''class Estimator:
    def set_params(self, **parameters):
        assert parameters == {'winning': 7}
    def fit(self, frame, y):
        assert list(frame['id']) == ['train/a.0', 'train/b.1', 'train/c.0', 'train/d.1']
        assert list(y) == [0, 1, 0, 1]
        self.rows = len(y)
        return self
    def predict(self, frame):
        assert self.rows == 4
        return [0] * len(frame)
def build(context):
    assert context == {'parameters': {'fixed': 3}, 'seed': 11}
    return Estimator()
''')
        if not serializable:
            module.write_text(module.read_text().replace('    def set_params', "    def __getstate__(self):\n        raise TypeError('opaque native handle')\n    def set_params"))
        freeze = {'schemaVersion': 1, 'identity': 'fixture', 'terminalPath': str(self.root / 'terminal.json'),
                  'sourceRoot': str(source), 'source': {'commit': 'frozen', 'tree': 'tree'},
                  'inputs': self.inputs, 'data': worker.data(self.inputs),
                  'pipeline': {'module': 'solutions/pipeline.py', 'factory': 'build', 'parameters': {'fixed': 3}, 'estimatorParams': {'winning': 7}},
                  'seed': 11, 'seedLineage': {'original': 13}, 'environment': {'fingerprint': 'fixture'}, 'evidence': []}
        raw = json.dumps(freeze)
        (self.root / 'freeze.json').write_text(raw)
        with self.assertRaises(FileNotFoundError):
            worker.fit(self.root, freeze)
        (self.root / 'terminal.json').write_text(raw)
        with contextlib.redirect_stdout(io.StringIO()):
            worker.fit(self.root, freeze)
        return freeze

    def test_full_fit_requires_freeze_and_retains_fixed_parameters(self):
        freeze = self.fit()
        result = worker.validate(self.root, freeze)
        self.assertEqual(result['fitCalls'], 1)
        self.assertEqual(result['trainRows'], 4)
        self.assertEqual(result['pipeline'], freeze['pipeline'])
        self.assertNotIn('metrics', result)

    def test_prediction_coverage_and_domain_checked_even_with_matching_hashes(self):
        freeze = self.fit()
        for rows, error in [('test/a.x,0\ntest/a.x,0\n', 'coverage'), ('test/a.x,0\ntest/extra.x,0\n', 'coverage'), ('test/a.x,0\ntest/b.x,2\n', 'domain')]:
            (self.root / 'predictions.csv').write_text('id,prediction\n' + rows)
            result = json.loads((self.root / 'result.json').read_text())
            result['artifacts']['predictions.csv'] = worker.sha(self.root / 'predictions.csv')
            (self.root / 'result.json').write_text(json.dumps(result))
            with self.assertRaisesRegex(AssertionError, error):
                worker.validate(self.root, freeze)

    def test_model_corruption_and_false_completion_refused(self):
        freeze = self.fit()
        (self.root / 'model.pkl').write_bytes(b'corrupt')
        with self.assertRaisesRegex(AssertionError, 'checksum'):
            worker.validate(self.root, freeze)
        result = json.loads((self.root / 'result.json').read_text())
        result['fitCalls'] = 0
        (self.root / 'result.json').write_text(json.dumps(result))
        with self.assertRaises(AssertionError):
            worker.validate(self.root, freeze)

    def test_unserializable_estimator_keeps_authoritative_predictions_without_refitting(self):
        freeze = self.fit(serializable=False)
        result = worker.validate(self.root, freeze)
        self.assertEqual(result['modelSerialization'], {'status': 'unavailable', 'errorType': 'TypeError'})
        self.assertNotIn('model.pkl', result['artifacts'])
        self.assertEqual(result['fitCalls'], 1)

    def test_original_content_must_match_measured_development_rows(self):
        with zipfile.ZipFile(self.inputs['trainZip'], 'w') as archive:
            for name in self.train:
                archive.writestr(name, 'drifted body' if name == self.train[0] else 'fixture body')
        with self.assertRaisesRegex(AssertionError, 'content differs'):
            worker.data(self.inputs)
