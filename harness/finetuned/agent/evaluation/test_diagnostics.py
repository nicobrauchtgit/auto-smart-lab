import csv
import json
import tempfile
import unittest
from pathlib import Path

from diagnostics import diagnose


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'dev.labels').write_text('a;0\nb;0\nc;1\nd;1\n')
        self.rows = [dict(id=i, repeat=0, fold=f, prediction=p, score=s)
                     for i, f, p, s in [('a', 0, 0, .1), ('b', 1, 1, .8),
                                        ('c', 0, 1, .9), ('d', 1, 1, .7)]]
        self.write('invocation.json', {'inputs': {'labelsPath': str(self.root / 'dev.labels')},
                                     'request': {'cv': {'repeats': 1}}})
        self.write('trial-result.json', {'experimentId': 'fixture', 'metrics': {'balancedAccuracy': .75}})
        self.flush()

    def write(self, name, data):
        (self.root / name).write_text(json.dumps(data))

    def flush(self):
        self.write('fold-manifest.json', {'assignments': [dict(r) for r in self.rows]})
        with (self.root / 'oof_predictions.csv').open('w') as f:
            writer = csv.DictWriter(f, fieldnames=['id', 'repeat', 'fold', 'prediction', 'score'], delimiter=';')
            writer.writeheader()
            writer.writerows(self.rows)

    def test_known_metrics_and_curves(self):
        data = diagnose(self.root)
        self.assertEqual(data['summary']['balancedAccuracy'], .75)
        self.assertEqual(data['summary']['confusionMatrix'], [[1, 1], [0, 2]])
        self.assertAlmostEqual(data['summary']['macroF1'], (2/3 + .8)/2)
        self.assertEqual(data['curves']['rocAuc'], .75)
        self.assertAlmostEqual(data['curves']['averagePrecision'], 5/6)
        self.assertEqual(len(data['folds']), 2)
        self.assertTrue(all(len(p) == 2 for p in data['curves']['roc']))

    def test_repeats_are_not_independent_samples(self):
        self.rows += [{**r, 'repeat': 1} for r in self.rows]
        self.write('invocation.json', {'inputs': {'labelsPath': str(self.root / 'dev.labels')}, 'request': {'cv': {'repeats': 2}}})
        self.flush()
        data = diagnose(self.root)
        self.assertEqual(data['summary']['uniqueRows'], 4)
        self.assertEqual(data['summary']['rows'], 8)
        self.assertIn('correlated', ' '.join(data['limitations']))

    def test_missing_scores_are_explicit_and_margins_supported(self):
        self.rows[0]['score'] = ''
        self.flush()
        self.assertFalse(diagnose(self.root)['curves']['available'])
        for i, r in enumerate(self.rows):
            r['score'] = [-10, 8, 9, 7][i]
        self.flush()
        self.assertEqual(diagnose(self.root)['curves']['rocAuc'], .75)

    def test_manifest_mismatch_and_duplicate_rows_fail(self):
        self.rows.append(dict(self.rows[0]))
        self.flush()
        with self.assertRaisesRegex(ValueError, 'manifest'):
            diagnose(self.root)
        self.rows.pop()
        self.flush()
        self.write('fold-manifest.json', {'assignments': []})
        with self.assertRaisesRegex(ValueError, 'manifest'):
            diagnose(self.root)

    def test_missing_or_foreign_ids_and_bad_metrics_fail(self):
        self.rows[0]['id'] = 'sealed-or-unknown'
        self.flush()
        with self.assertRaisesRegex(ValueError, 'development ID'):
            diagnose(self.root)
        self.rows[0]['id'] = 'a'
        self.flush()
        self.write('trial-result.json', {'experimentId': 'fixture', 'metrics': {'balancedAccuracy': 1}})
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            diagnose(self.root)

    def test_raw_sample_manifest_supplies_the_labels(self):
        (self.root / 'samples.json').write_text(json.dumps({'schemaVersion': 1, 'samples': [
            {'id': i, 'input': {'archive': 'dev.zip', 'member': i}, 'target': t} for i, t in [('a', 0), ('b', 0), ('c', 1), ('d', 1)]]}))
        self.write('invocation.json', {'measurement': {'kind': 'classification', 'execution': 'inductive',
                                                       'sampleManifestPath': str(self.root / 'samples.json')},
                                       'inputs': {}, 'request': {'cv': {'repeats': 1}}})
        data = diagnose(self.root)
        self.assertEqual(data['summary']['balancedAccuracy'], .75)
        self.assertEqual(data['curves']['rocAuc'], .75)

    def test_nonfinite_scores_fail(self):
        self.rows[0]['score'] = 'nan'
        self.flush()
        with self.assertRaisesRegex(ValueError, 'Non-finite'):
            diagnose(self.root)


class ClusteringDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        families = {'a': 'f1', 'b': 'f1', 'c': 'f2', 'd': 'f2', 'e': 'f3', 'f': 'f3', 'g': 'f4', 'h': 'f4'}
        (self.root / 'samples.json').write_text(json.dumps({'schemaVersion': 1, 'samples': [
            {'id': i, 'input': {'archive': 'dev.zip', 'member': i}, 'target': t} for i, t in families.items()]}))
        # Fold 0 recovers its two families; fold 1 merges them into one cluster.
        self.rows = [dict(id=i, repeat=0, fold=f, prediction=p, score='')
                     for i, f, p in [('a', 0, 7), ('b', 0, 7), ('c', 0, 3), ('d', 0, 3),
                                     ('e', 1, 0), ('f', 1, 0), ('g', 1, 0), ('h', 1, 0)]]
        (self.root / 'invocation.json').write_text(json.dumps({'measurement': {'kind': 'clustering', 'execution': 'batch',
            'sampleManifestPath': str(self.root / 'samples.json')}, 'request': {'cv': {'repeats': 1}}}))
        (self.root / 'trial-result.json').write_text(json.dumps({'experimentId': 'fixture', 'metrics': {'adjustedRandIndex': .5}}))
        (self.root / 'fold-manifest.json').write_text(json.dumps({'assignments': [dict(r) for r in self.rows]}))
        with (self.root / 'oof_predictions.csv').open('w') as f:
            writer = csv.DictWriter(f, fieldnames=['id', 'repeat', 'fold', 'prediction', 'score'], delimiter=';')
            writer.writeheader()
            writer.writerows(self.rows)

    def test_batch_ari_is_recomputed_per_fold_and_never_pooled(self):
        data = diagnose(self.root)
        self.assertEqual(data['measurementKind'], 'clustering')
        self.assertEqual([f['adjustedRandIndex'] for f in data['folds']], [1.0, 0.0])
        self.assertEqual(data['summary']['adjustedRandIndex'], .5)
        self.assertEqual(data['folds'][1]['clusters'], 1)
        self.assertEqual(data['folds'][1]['completeness'], 1.0)
        self.assertFalse(data['curves']['available'])

    def test_result_disagreement_fails(self):
        (self.root / 'trial-result.json').write_text(json.dumps({'experimentId': 'fixture', 'metrics': {'adjustedRandIndex': .9}}))
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            diagnose(self.root)


if __name__ == '__main__':
    unittest.main()
