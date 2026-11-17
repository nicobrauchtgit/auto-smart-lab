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
        for name in ('search-checkpoint.json', 'configs.jsonl'):
            path = search.output_dir / name
            if path.exists(): self.assertNotIn('anchorPredictions', path.read_text())
        self.assertNotIn('anchorPredictions', json.dumps(outcome['best'].record(None)))
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
        # The last fit must contribute, even though the first 256 pairs omit it.
        distinct = [{'anchorPredictions': [0, 0, 1, 1]} for _ in range(258)]
        distinct[-1] = {'anchorPredictions': [0, 1, 0, 1]}
        self.assertLess(test_agreement(distinct)['minAdjustedRandIndex'], 1)
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
        def slow(*_):
            import ctypes
            ctypes.CDLL(None).sleep(30)
        document['anchorTimeoutSeconds'] = .01
        with patch('smoke.batch_fit_predict', side_effect=slow):
            started = time.monotonic()
            result = smoke.outcome(document)
            value = result['testPart']
            self.assertTrue(result['passed'])
            self.assertLess(time.monotonic() - started, 2)
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
        (self.root/'model.py').write_text("class Model:\n def fit_predict(self, frame):\n  assert frame['id'].tolist() == ['sealed-a','sealed-b'] + [f'test-{i}' for i in range(7)]\n  assert set(frame.columns) == {'id','input'}\n  assert frame.iloc[0]['input'] == {}\n  return [i % 2 for i in range(len(frame))]\ndef build_pipeline(context):\n assert context['seed'] == 13\n return Model()\n")
        freeze = dict(taskId='fixture',experimentId='trial',source={},pipeline={'module':'model.py','factory':'build_pipeline'},
            holdout={'perClass':{'a':1,'b':1},'rows':2},readCount=1,identity='frozen',population='tiny',origin={},cvMean=.5,
            seed=13,bootstrapSeed=42,kind='clustering',execution='batch',sourceRoot=str(self.root),developmentManifest=dev,
            validationManifest=sealed,hashes={},**{k:v for k,v in self.config.items() if k.startswith('anchor')})
        (self.root/'freeze.json').write_text(json.dumps(freeze))
        with contextlib.redirect_stdout(io.StringIO()): confirm.run(self.root)
        receipt = confirm.validate(self.root)
        # Delivery must use the confirmation archive descriptors, not trainZip.
        frozen_confirmation = {'resultPath': str(self.root/'holdout-confirmation.json'), 'resultSha256': refit.sha(self.root/'holdout-confirmation.json'), 'manifestPath': sealed}
        from smartlab_trial.agent_code import _load_module
        estimator = _load_module(self.root,'model.py').build_pipeline({'seed':13})
        frozen = {'inputs':{'task':{'kind':'clustering','execution':'batch'},'trainZip':str(train_zip),'testZip':str(test_zip),
            'sealedIds':['sealed-a','sealed-b']},'confirmation':frozen_confirmation,
            'chosenExperimentId':'trial','source':{},'pipeline':{'module':'model.py','factory':'build_pipeline'},'seed':13,'data':{'trainIds':['dev-a','dev-b','sealed-a','sealed-b'],'testIds':[f'test-{i}' for i in range(7)]}}
        with contextlib.redirect_stdout(io.StringIO()): predicted, fit_rows, test_rows = refit.fit_samples(estimator,frozen,EventWriter(self.root,'test'))
        self.assertTrue(refit.partition_check(frozen, predicted)['matches'])
        self.assertEqual(predicted, receipt['testPredictions']); self.assertEqual((fit_rows,test_rows),(9,7))
        # Exercise the terminal exact-ID validator, including a checksum-valid duplicate.
        frozen.update(identity='terminal', source={}, environment={}, seed=13, seedLineage={}, evidence=[])
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
            source={},pipeline=frozen['pipeline'],environment={},seed=13,seedLineage={},evidence=[],data={},
            deliveredPredictionSource='confirmation', confirmationPartition=refit.partition_check(frozen,predicted))
        (self.root/'result.json').write_text(json.dumps(result))
        refit.validate(self.root, frozen)
        write(['test-0']*7)
        result['artifacts']['predictions.csv'] = refit.sha(predictions)
        (self.root/'result.json').write_text(json.dumps(result))
        with self.assertRaisesRegex(AssertionError, 'coverage'): refit.validate(self.root, frozen)


    def test_delivery_uses_confirmation_and_records_replay(self):
        spec = importlib.util.spec_from_file_location('refit_check', Path(__file__).resolve().parents[2] / 'refit/worker.py')
        refit = importlib.util.module_from_spec(spec); spec.loader.exec_module(refit)
        ids = ['a', 'b', 'c', 'd']
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({'status': 'completed', 'testIds': ids, 'testPredictions': [0, 0, 1, 1],
                                       'experimentId': 'exp', 'source': {}, 'pipeline': {'module':'x','factory':'x'}, 'seed': 0}))
        frozen = {'chosenExperimentId': 'exp', 'confirmation': {'resultPath': str(receipt), 'resultSha256': refit.sha(receipt)},
                  'terminalPath': str(self.root/'freeze.json'), 'inputs': {},
                  'data': {'trainIds': [], 'testIds': ids, 'trainRows': 0, 'testRows': 4, 'hashes': {}},
                  'sourceRoot': str(self.root), 'pipeline': {'module':'x','factory':'x'},
                  'seed': 0, 'identity':'fixture', 'source': {}, 'environment': {}, 'seedLineage': {}, 'evidence': []}
        class Nondeterministic:
            def fit_predict(self, frame):
                import secrets
                return [0, 1, 0, 1] if secrets.randbits(1) else [0, 1, 1, 0]
        model = Nondeterministic()
        for mode in ('mismatch', 'match', 'no-confirmation'):
            with self.subTest(mode=mode):
                if mode == 'no-confirmation': frozen.pop('confirmation')
                (self.root/'freeze.json').write_text(json.dumps(frozen))
                replay = [7,7,3,3] if mode == 'match' else model.fit_predict(None)
                with patch.object(refit, 'data', return_value=frozen['data']), patch.object(refit, '_load_module'), \
                     patch.object(refit, '_factory'), patch.object(refit, '_call_pipeline_factory', return_value=model), \
                     patch.object(refit, 'fit_samples', return_value=(replay, 4, 4)):
                    refit.fit(self.root, frozen)
                result = json.loads((self.root/'result.json').read_text())
                import csv
                with (self.root/'predictions.csv').open() as stream:
                    delivered = [int(row['prediction']) for row in csv.DictReader(stream)]
                self.assertEqual(delivered, replay if mode == 'no-confirmation' else [0,0,1,1])
                self.assertEqual(result['deliveredPredictionSource'], 'refit' if mode == 'no-confirmation' else 'confirmation')
                if mode != 'no-confirmation':
                    self.assertEqual(result['confirmationPartition']['matches'], mode == 'match')
                    self.assertIn('reason', result['confirmationPartition'])

    def test_confirmation_predictions_reject_tampering_order_coverage_and_domain(self):
        spec = importlib.util.spec_from_file_location('refit_check', Path(__file__).resolve().parents[2] / 'refit/worker.py')
        refit = importlib.util.module_from_spec(spec); spec.loader.exec_module(refit)
        receipt = self.root/'receipt.json'
        identity = {'experimentId': 'exp', 'source': {'commit': 'c'}, 'pipeline': {'module': 'm', 'factory': 'f'}, 'seed': 5}
        frozen = {'confirmation': {'resultPath': str(receipt)}, 'data': {'testIds': ['a','b']},
                  'chosenExperimentId': 'exp', 'source': {'commit': 'c'}, 'pipeline': {'module': 'm', 'factory': 'f', 'parameters': {}}, 'seed': 5}
        receipt.write_text(json.dumps({'status':'completed', 'testIds':['a','b'], 'testPredictions':[0,1], **identity}))
        frozen['confirmation']['resultSha256'] = refit.sha(receipt)
        self.assertEqual(refit.confirmation_predictions(frozen), [0, 1])
        for ids, values in [(['b','a'], [0,1]), (['a','b'], [0]), (['a','b'], [0,1.5]), (['a','a'], [0,1])]:
            receipt.write_text(json.dumps({'status':'completed', 'testIds':ids, 'testPredictions':values, **identity}))
            frozen['confirmation']['resultSha256'] = refit.sha(receipt)
            with self.assertRaises(AssertionError): refit.confirmation_predictions(frozen)
        # A receipt for another champion, source, pipeline or seed is never delivered.
        for change, message in [({'experimentId': 'other'}, 'another experiment'), ({'source': {'commit': 'd'}}, 'source differs'),
                                ({'pipeline': {'module': 'm', 'factory': 'g'}}, 'pipeline differs'), ({'seed': 6}, 'seed differs')]:
            receipt.write_text(json.dumps({'status':'completed', 'testIds':['a','b'], 'testPredictions':[0,1], **identity, **change}))
            frozen['confirmation']['resultSha256'] = refit.sha(receipt)
            with self.assertRaisesRegex(AssertionError, message): refit.confirmation_predictions(frozen)
        receipt.write_text('{}')
        with self.assertRaisesRegex(AssertionError, 'receipt changed'): refit.confirmation_predictions(frozen)

    def test_smoke_kmeans_after_parent_openmp_fit(self):
        dev = self.root/'dev.json'
        dev.write_text(json.dumps({'schemaVersion':1, 'samples':[
            {'id':f'dev-{i}', 'input':{}, 'target':'family'} for i in range(20)]}))
        (self.root/'kmeans.py').write_text("from sklearn.cluster import KMeans\nimport numpy as np\nclass Model:\n def fit_predict(self, frame):\n  assert set(frame.columns) == {'id','input'}\n  return KMeans(n_clusters=2, n_init=1, random_state=0).fit_predict(np.arange(len(frame)*2).reshape(-1,2))\ndef build_pipeline(): return Model()\n")
        document = dict(sourceRoot=str(self.root), measurement={**self.config, 'sampleManifestPath':str(dev)},
            request={'pipeline':{'module':'kmeans.py','factory':'build_pipeline'}}, sealedRows=5)
        # outcome first runs KMeans in this parent, then again in the child.
        result = smoke.outcome(document)
        self.assertTrue(result['passed'])
        self.assertTrue(result['testPart']['available'], result)


if __name__ == '__main__': unittest.main()
