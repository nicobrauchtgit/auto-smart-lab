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

    def test_nonfinite_scores_fail(self):
        self.rows[0]['score'] = 'nan'
        self.flush()
        with self.assertRaisesRegex(ValueError, 'Non-finite'):
            diagnose(self.root)


if __name__ == '__main__':
    unittest.main()
