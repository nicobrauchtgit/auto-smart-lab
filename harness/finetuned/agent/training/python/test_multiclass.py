"""String class labels retain their domain through smoke and terminal refit."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from smoke import outcome
from smartlab_trial.metrics import _measure
from smartlab_trial.class_labels import predictions

class MulticlassTests(unittest.TestCase):
    def test_proxy_receives_class_names(self):
        from types import SimpleNamespace
        from smartlab_trial.extra_measurements import proxy_score
        class Estimator:
            def score(self, frame, y):
                assert y == ['a', 'b']
                return .75
        invocation = SimpleNamespace(measurement={'kind': 'multiclass_classification'}, search=SimpleNamespace(objective={'metric': 'estimator_score', 'direction': 'maximize'}))
        self.assertEqual(proxy_score(invocation, Estimator(), None, ['a', 'b'], {})['value'], .75)

    def test_metrics_and_domain(self):
        result = _measure(['a', 'a', 'b', 'c'], ['a', 'b', 'b', 'c'])
        self.assertAlmostEqual(result['balancedAccuracy'], 5 / 6)
        self.assertEqual(result['accuracy'], .75)
        self.assertEqual(result['topConfusions'], [dict(true='a', predicted='b', rows=1)])
        with self.assertRaisesRegex(ValueError, 'training class label set'):
            predictions(['unknown'], 1, ['a', 'b'])

    def test_smoke_rejects_unknown_class(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'samples.json'
            manifest.write_text(json.dumps(dict(schemaVersion=1,samples=[dict(id=str(i),input={},target=['a','b','c'][i%3]) for i in range(30)])))
            (root / 'pipeline.py').write_text("class Model:\n def fit(self,X,y): return self\n def predict(self,X): return ['unknown']*len(X)\ndef build_pipeline(): return Model()\n")
            result = outcome(dict(sourceRoot=directory,request=dict(pipeline=dict(module='pipeline.py',factory='build_pipeline')),measurement=dict(kind='multiclass_classification',execution='inductive',sampleManifestPath=str(manifest))))
            self.assertFalse(result['passed'])
            self.assertEqual(result['phase'], 'output')
            self.assertIn('training class label set', result['error']['message'])

    def test_refit_rejects_unknown_class(self):
        spec = importlib.util.spec_from_file_location('multiclass_refit', Path(__file__).resolve().parents[2] / 'refit' / 'worker.py')
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        class Events:
            def stage(self,*args,**kwargs): return contextlib.nullcontext()
        class Estimator:
            def fit(self,X,y):
                assert y == ['a','b','c']
            def predict(self,X): return ['unknown']*len(X)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for filename, ids in [('train.zip',['a','b','c']),('test.zip',['test'])]:
                with zipfile.ZipFile(root/filename,'w') as archive:
                    for row_id in ids: archive.writestr(row_id,'bytes')
            (root/'labels').write_text('a;a\nb;b\nc;c\n')
            freeze=dict(inputs=dict(task=dict(kind='multiclass_classification',targets='multiclass'),trainZip=str(root/'train.zip'),testZip=str(root/'test.zip'),targetsPath=str(root/'labels')),data=dict(trainIds=['a','b','c'],testIds=['test']))
            with self.assertRaisesRegex(ValueError, 'training class label set'):
                worker.fit_samples(Estimator(),freeze,Events())
