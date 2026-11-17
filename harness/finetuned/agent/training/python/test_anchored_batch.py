"""Anchored clustering populations, scores, replay and delivery regression tests."""
import contextlib
import io
import json
import hashlib
import importlib.util
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import pandas as pd
from smartlab_trial.batch import batch_fit_predict, load_anchor, test_agreement, MAX_AGREEMENT_PAIRS
from smartlab_trial.invocation import parse_invocation
from smartlab_trial.measurement import load_samples, validate_config
from smartlab_trial.folds import ConcreteFold
from smartlab_trial.artifacts import EventWriter
import worker
import smoke
import confirm
import test_worker


class AnchoredBatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.anchor = self.root / 'anchor.json'
        self.anchor.write_text(json.dumps({'schemaVersion': 1, 'samples': [
            {'id': f'test-{i}', 'input': {}} for i in range(7)]}))
        self.config = dict(kind='clustering', execution='batch', anchorManifestPath=str(self.anchor),
            anchorManifestSha256=hashlib.sha256(self.anchor.read_bytes()).hexdigest())

    def test_helper_target_free_unique_order_and_fallback(self):
        labelled = pd.DataFrame([{'id': 'dev-a', 'input': {}}, {'id': 'dev-b', 'input': {}}])
        anchor = load_anchor(self.config, labelled)
        seen = []
        class Model:
            def fit(self, frame):
                seen.extend(frame['id'])
                assert set(frame.columns) == {'id', 'input'}
            def predict(self, frame): return list(range(len(frame)))
        a, b = batch_fit_predict(Model(), labelled, anchor)
        self.assertEqual(seen, ['dev-a', 'dev-b'] + [f'test-{i}' for i in range(7)])
        self.assertEqual(a, [0, 1]); self.assertEqual(b, list(range(2, 9)))
        with self.assertRaises(Exception): batch_fit_predict(Model(), labelled.assign(target='family'), anchor)
        with self.assertRaises(Exception): batch_fit_predict(Model(), anchor, anchor)
        self.anchor.write_text(self.anchor.read_text() + ' ')
        with self.assertRaises(Exception): load_anchor(self.config)

    def trial(self):
        fixture = test_worker.Worker(); fixture.setUp()
        self.addCleanup(lambda: __import__('shutil').rmtree(fixture.root))
        doc = fixture.invocation('anchored')
        # Only development rows are present in the manifest; a sealed ID is absent.
        samples = json.loads(fixture.sample_path.read_text())
        for sample in samples['samples']: sample['target'] = str(sample['target'])
        fixture.sample_path.write_text(json.dumps(samples))
        doc['measurement'] = {**self.config, 'sampleManifestPath': str(fixture.sample_path)}
        return doc

    def test_fold_scores_oof_and_search_configuration_zero(self):
        invocation = parse_invocation(self.trial())
        frame, y, _ = load_samples(invocation.measurement)
        ids = frame['id'].tolist()
        seen = []
        class Model:
            def fit_predict(self, batch):
                seen.append(batch['id'].tolist())
                assert set(batch.columns) == {'id', 'input'}
                # Perfect validation clustering, arbitrary test partition.
                return [int(name.rsplit('.', 1)[1]) if name in ids else 42 for name in batch['id']]
        factory = lambda context: Model()
        fold = ConcreteFold(repeat=0, fold=0, train=tuple(range(12)), validation=tuple(range(12,24)), seed=13)
        start = time.monotonic()
        result, oof = worker._run_fold(invocation, factory, fold, frame, y, ids)
        print('anchored fixture fold seconds:', time.monotonic()-start)
        self.assertEqual(result['metrics']['adjustedRandIndex'], 1)
        self.assertEqual(result['fitRows'], 19)
        self.assertEqual(result['diagnostics']['testPart']['rows'], 7)
        self.assertEqual([row['id'] for row in oof], ids[12:])
        self.assertEqual(seen[0], ids[12:] + [f'test-{i}' for i in range(7)])
        self.assertNotIn('sealed', ' '.join(seen[0]))
        from dataclasses import replace
        from smartlab_trial.invocation import SearchSpec
        from smartlab_trial.search import run_search
        search = replace(invocation, search=SearchSpec({'factory.dummy': {'type': 'categorical', 'choices': [0]}}, 'grid', 1, False, None))
        search.output_dir.mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            outcome = run_search(search, EventWriter(search.output_dir, search.experiment_id), search.output_dir,
                factory, [fold], frame, y, ids, lambda: False, worker._run_fold)
        replay = outcome['best'].folds[0]
        for key in ('metrics', 'diagnostics', 'seededParameters', 'anchorPredictions', 'fitRows'):
            self.assertEqual(result[key], replay[key])
        self.assertEqual(oof, outcome['best'].oof)
        from smartlab_trial.artifacts import _write_oof
        import csv
        path = self.root / 'oof_predictions.csv'
        _write_oof(path, oof)
        with path.open() as stream:
            stored = list(csv.DictReader(stream, delimiter=";"))
        self.assertEqual([row['id'] for row in stored], ids[12:])
        from smartlab_trial import diagnostics
        summary = diagnostics.summary('clustering', [result, replay], oof)
        self.assertEqual(summary['testAgreement'], {'available': True, 'meanAdjustedRandIndex': 1.0,
            'minAdjustedRandIndex': 1.0, 'comparisons': 1})

    def test_agreement_bounded_and_unavailable(self):
        self.assertFalse(test_agreement([])['available'])
        folds = [{'anchorPredictions': [i % 2, 1, 1, 0]} for i in range(30)]
        result = test_agreement(folds)
        self.assertEqual(result['comparisons'], MAX_AGREEMENT_PAIRS)
        self.assertEqual(result, test_agreement(folds))
        self.assertLessEqual(result['minAdjustedRandIndex'], result['meanAdjustedRandIndex'])

    def test_smoke_structure_only_and_timeout(self):
        dev = self.root / 'dev.json'
        dev.write_text(json.dumps({'schemaVersion': 1, 'samples': [{'id': f'dev-{i}', 'input': {}, 'target': 'family'} for i in range(20)]}))
        (self.root / 'pipeline.py').write_text('class Model:\n def fit_predict(self, frame): return [0] * len(frame)\ndef build_pipeline(): return Model()\n')
        document = dict(sourceRoot=str(self.root), measurement={**self.config, 'sampleManifestPath': str(dev)},
            request={'pipeline': {'module': 'pipeline.py', 'factory': 'build_pipeline'}}, sealedRows=5)
        result = smoke.outcome(document)
        self.assertTrue(result['passed']); self.assertEqual(result['testPart']['rows'], 7)
        self.assertEqual(result['testPart']['clusterCount'], 1)
        for forbidden in ('adjustedRandIndex', 'family', 'target', 'external'):
            self.assertNotIn(forbidden, json.dumps(result))
        def slow(*_): time.sleep(.1)
        document['anchorTimeoutSeconds'] = .01
        with patch('smoke.batch_fit_predict', side_effect=slow):
            value = smoke.anchored_structure(document, self.root, load_samples(document['measurement'])[0])
        self.assertEqual(value, {'available': False, 'reason': 'Timeout'})

    def test_confirmation_and_delivery_identical_order_and_predictions(self):
        import zipfile
        spec = importlib.util.spec_from_file_location('refit_worker', Path(__file__).resolve().parents[2] / 'refit/worker.py')
        refit = importlib.util.module_from_spec(spec); spec.loader.exec_module(refit)
        train_zip, test_zip = self.root/'train.zip', self.root/'test.zip'
        with zipfile.ZipFile(train_zip, 'w') as z:
            for name in ['sealed-b','dev-b','sealed-a','dev-a']: z.writestr(name, name)
        with zipfile.ZipFile(test_zip, 'w') as z:
            for i in reversed(range(7)): z.writestr(f'test-{i}', str(i))
        def manifest(name, ids):
            path = self.root/name
            path.write_text(json.dumps({'schemaVersion':1, 'samples':[{'id':i,'input':{},'target':i[-1]} for i in ids]}))
            return str(path)
        dev = manifest('dev.json',['dev-b','dev-a']); sealed = manifest('sealed.json',['sealed-b','sealed-a'])
        (self.root/'model.py').write_text("class Model:\n def fit_predict(self, frame):\n  assert frame['id'].tolist() == ['sealed-a','sealed-b'] + [f'test-{i}' for i in range(7)]\n  assert set(frame.columns) == {'id','input'}\n  return [i % 2 for i in range(len(frame))]\ndef build_pipeline(context):\n assert context['seed'] == 13\n return Model()\n")
        freeze = dict(taskId='fixture',experimentId='trial',source={},pipeline={'module':'model.py','factory':'build_pipeline'},
            holdout={'perClass':{'a':1,'b':1},'rows':2},readCount=1,identity='frozen',population='tiny',origin={},cvMean=.5,
            seed=13,bootstrapSeed=42,kind='clustering',execution='batch',sourceRoot=str(self.root),developmentManifest=dev,
            validationManifest=sealed,hashes={},**{k:v for k,v in self.config.items() if k.startswith('anchor')})
        (self.root/'freeze.json').write_text(json.dumps(freeze))
        with contextlib.redirect_stdout(io.StringIO()): confirm.run(self.root)
        receipt = confirm.validate(self.root)
        from smartlab_trial.agent_code import _load_module
        estimator = _load_module(self.root,'model.py').build_pipeline({'seed':13})
        frozen = {'inputs':{'task':{'kind':'clustering','execution':'batch'},'trainZip':str(train_zip),'testZip':str(test_zip),
            'sealedIds':['sealed-a','sealed-b']},'data':{'trainIds':['dev-a','dev-b','sealed-a','sealed-b'],'testIds':[f'test-{i}' for i in range(7)]}}
        with contextlib.redirect_stdout(io.StringIO()): predicted, fit_rows, test_rows = refit.fit_samples(estimator,frozen,EventWriter(self.root,'test'))
        self.assertEqual(predicted, receipt['testPredictions']); self.assertEqual((fit_rows,test_rows),(9,7))
        # Exercise the terminal exact-ID validator, including a checksum-valid duplicate.
        frozen.update(identity='terminal', source={}, pipeline={}, environment={}, seed=13, seedLineage={}, evidence=[])
        frozen['data'].update(trainRows=4, testRows=7, hashes={})
        (self.root/'freeze.json').write_text(json.dumps(frozen))
        import csv
        predictions = self.root/'predictions.csv'
        def write(ids):
            with predictions.open('w') as stream:
                writer = csv.writer(stream); writer.writerow(['id','prediction']); writer.writerows(zip(ids,predicted))
        write(frozen['data']['testIds'])
        result = dict(schemaVersion=1, status='completed', identity='terminal', freezeSha256=refit.sha(self.root/'freeze.json'),
            trainRows=4, fitCalls=1, testRows=7,
            trainIdsSha256=hashlib.sha256(json.dumps(frozen['data']['trainIds'], separators=(',', ':')).encode()).hexdigest(),
            modelSerialization={'status':'unavailable','errorType':'Fixture'}, artifacts={'predictions.csv':refit.sha(predictions)},
            source={},pipeline={},environment={},seed=13,seedLineage={},evidence=[],data={})
        (self.root/'result.json').write_text(json.dumps(result))
        refit.validate(self.root, frozen)
        write(['test-0']*7)
        result['artifacts']['predictions.csv'] = refit.sha(predictions)
        (self.root/'result.json').write_text(json.dumps(result))
        with self.assertRaisesRegex(AssertionError, 'coverage'): refit.validate(self.root, frozen)


if __name__ == '__main__': unittest.main()
