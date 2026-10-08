"""Declared sample identity and the generic terminal refit, on local fixtures."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import task_samples

REFIT = Path(__file__).resolve().parents[2] / 'refit' / 'worker.py'
spec = importlib.util.spec_from_file_location('terminal_worker_samples_test', REFIT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Events:
    """Stand-in for the event writer: records stage names only."""
    def __init__(self):
        self.stages = []

    @contextlib.contextmanager
    def stage(self, name, **_fields):
        self.stages.append(name)
        yield


class FamilyFromContent:
    """Reads each archive member like agent code would; clusters by its first byte."""
    def __init__(self, with_fit_predict=True):
        self.fitted = None
        if not with_fit_predict:
            self.fit_predict = None

    @staticmethod
    def _keys(frame):
        keys = []
        for descriptor in frame['input']:
            with zipfile.ZipFile(descriptor['archive']) as archive:
                keys.append(archive.read(descriptor['member'])[:1].decode())
        return keys

    def fit(self, frame, y=None):
        assert y is None, 'targets must never reach a sample-task fit'
        self.fitted = sorted(set(self._keys(frame)))
        return self

    def predict(self, frame):
        return [self.fitted.index(key) if key in self.fitted else -1 for key in self._keys(frame)]

    def fit_predict(self, frame):
        return self.fit(frame).predict(frame)


class SampleFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.train = {f'train/{i}.bin': family for i, family in enumerate('aabbccdd')}
        self.test = {'test/x.bin': 'e', 'test/y.bin': 'e', 'test/z.bin': 'f'}
        self.zip('train.zip', self.train)
        self.zip('test.zip', self.test)
        self.targets = self.root / 'train.labels'
        self.targets.write_text(''.join(f'{name};{family}\n' for name, family in self.train.items()))

    def zip(self, name, members):
        with zipfile.ZipFile(self.root / name, 'w') as archive:
            for member, family in members.items():
                archive.writestr(member, family + ' sample body')
        return str(self.root / name)


class TaskSamplesTest(SampleFixture):
    def spec(self, **overrides):
        return {'trainZip': str(self.root / 'train.zip'), 'testZip': str(self.root / 'test.zip'),
                'targetsPath': str(self.targets), 'targets': 'families', 'neutralTestIds': False, **overrides}

    def test_families_are_counted_without_reading_samples(self):
        facts = task_samples.inspect(self.spec())
        self.assertEqual(facts['trainRows'], 8)
        self.assertEqual(facts['testRows'], 3)
        self.assertEqual(facts['targets'], {'kind': 'families', 'families': 4, 'largest': 2, 'smallest': 2, 'singletons': 0})

    def test_targets_must_cover_exactly_the_training_samples(self):
        self.targets.write_text(''.join(f'{name};x\n' for name in list(self.train)[:-1]))
        with self.assertRaisesRegex(task_samples.TaskDataError, '1 without target'):
            task_samples.inspect(self.spec())

    def test_group_holdout_needs_three_families(self):
        self.targets.write_text(''.join(f'{name};{i % 2}\n' for i, name in enumerate(self.train)))
        with self.assertRaisesRegex(task_samples.TaskDataError, 'three families'):
            task_samples.inspect(self.spec())

    def test_binary_targets_need_both_classes_and_neutral_test_ids(self):
        self.targets.write_text(''.join(f'{name};{i % 2}\n' for i, name in enumerate(self.train)))
        with self.assertRaisesRegex(task_samples.TaskDataError, 'neutral'):
            task_samples.inspect(self.spec(targets='binary', neutralTestIds=True))
        self.targets.write_text(''.join(f'{name};2\n' for name in self.train))
        with self.assertRaisesRegex(task_samples.TaskDataError, '0 or 1'):
            task_samples.inspect(self.spec(targets='binary'))

    def test_overlap_and_embedded_targets(self):
        self.zip('test.zip', {'train/0.bin': 'a'})
        with self.assertRaisesRegex(task_samples.TaskDataError, 'share sample IDs'):
            task_samples.inspect(self.spec())
        self.zip('test.zip', self.test)
        with zipfile.ZipFile(self.root / 'train.zip', 'a') as archive:
            archive.writestr('train.labels', self.targets.read_bytes())
        self.assertEqual(task_samples.inspect(self.spec())['trainRows'], 8)
        with zipfile.ZipFile(self.root / 'train.zip', 'a') as archive:
            archive.writestr('other.labels', b'x')
        with self.assertRaisesRegex(task_samples.TaskDataError, 'without target|unknown'):
            task_samples.inspect(self.spec())

    def test_label_free_rows(self):
        self.assertEqual(task_samples.rows({'zip': str(self.root / 'train.zip'), 'targets': 'none'}),
                         {'ids': sorted(self.train), 'targets': None})


class SampleRefitTest(SampleFixture):
    def setUp(self):
        super().setUp()
        dev = sorted(self.train)[:6]
        self.zip('dev.zip', {name: self.train[name] for name in dev})
        manifest = self.root / 'development-samples.json'
        manifest.write_text(json.dumps({'schemaVersion': 1, 'samples': [
            {'id': name, 'input': {'archive': str(self.root / 'dev.zip'), 'member': name}, 'target': self.train[name]} for name in dev]}))
        self.inputs = {'kind': 'samples', 'task': {'kind': 'clustering', 'targets': 'families', 'execution': 'batch',
                                                    'predictions': 'cluster_id', 'measurement': {'kind': 'clustering', 'execution': 'batch'}},
                       'trainZip': str(self.root / 'train.zip'), 'testZip': str(self.root / 'test.zip'),
                       'targetsPath': str(self.targets), 'devZip': str(self.root / 'dev.zip'), 'devManifest': str(manifest)}

    def test_sample_data_binds_the_measured_development_subset(self):
        data = worker.data(self.inputs)
        self.assertEqual((data['trainRows'], data['developmentRows'], data['sealedRows'], data['testRows']), (8, 6, 2, 3))
        self.assertEqual(set(data['hashes']), {'trainZip', 'testZip', 'devZip', 'devManifest', 'targetsPath'})
        self.zip('dev.zip', {name: 'z' for name in sorted(self.train)[:6]})
        with self.assertRaisesRegex(AssertionError, 'content differs'):
            worker.data(self.inputs)

    def test_terminal_frame_excludes_identical_embedded_targets_sidecar(self):
        with zipfile.ZipFile(self.root / 'train.zip', 'a') as archive:
            archive.writestr(self.targets.name, self.targets.read_bytes())
        frame = worker.sample_frame(str(self.root / 'train.zip'), sorted(self.train), sidecar=str(self.targets))
        self.assertEqual(list(frame['id']), sorted(self.train))

    def test_batch_clustering_fits_the_test_batch_only(self):
        freeze = {'inputs': self.inputs, 'data': worker.data(self.inputs)}
        events = Events()
        predicted, fit_rows, test_rows = worker.fit_samples(FamilyFromContent(), freeze, events)
        self.assertEqual((predicted, fit_rows, test_rows), ([0, 0, 1], 3, 3))
        self.assertEqual(events.stages, ['terminal_fit'])
        # A clusterer without fit_predict is fitted and predicted on the same batch.
        predicted, _, _ = worker.fit_samples(FamilyFromContent(with_fit_predict=False), freeze, Events())
        self.assertEqual(predicted, [0, 0, 1])

    def test_inductive_fit_uses_all_training_samples_without_targets(self):
        self.inputs['task'].update(execution='inductive')
        freeze = {'inputs': self.inputs, 'data': worker.data(self.inputs)}
        predicted, fit_rows, _ = worker.fit_samples(FamilyFromContent(), freeze, Events())
        # Test families are unseen by the training fit, so they fall into noise.
        self.assertEqual((predicted, fit_rows), ([-1, -1, -1], 8))

    def test_anomaly_predictions_map_to_one_for_anomalies(self):
        self.inputs['task'].update(kind='anomaly_detection', targets='none', execution='inductive', predictions='binary',
                                   anomaly={'scoreMethod': 'score_samples', 'scoreDirection': 'lower_is_anomalous', 'anomalyLabel': -1})
        del self.inputs['targetsPath']
        freeze = {'inputs': self.inputs, 'data': worker.data(self.inputs)}
        predicted, _, _ = worker.fit_samples(FamilyFromContent(), freeze, Events())
        self.assertEqual(predicted, [1, 1, 1])


if __name__ == '__main__':
    unittest.main()
