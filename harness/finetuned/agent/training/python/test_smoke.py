"""Small execution checks for trial_smoke."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from smoke import smoke, outcome, SAMPLE_ROWS

# Rewritten fixtures of equal size would otherwise reuse a stale bytecode cache.
sys.dont_write_bytecode = True

MODEL = 'class Model:\n def fit(self, X, y=None):\n  {fit}\n  return self\n def predict(self, X): return [{label}] * len(X)\ndef build_pipeline(): return Model()\n'


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def document(self, rows, kind='classification', execution='inductive'):
        manifest = self.root / 'samples.json'
        manifest.write_text(json.dumps(dict(schemaVersion=1, samples=[
            dict(id=str(i), input={}, **(dict(target=i % 2) if kind == 'classification' else {})) for i in range(rows)])))
        return dict(sourceRoot=str(self.root), request=dict(pipeline=dict(module='pipeline.py', factory='build_pipeline')),
                    measurement=dict(kind=kind, execution=execution, sampleManifestPath=str(manifest)))

    def test_broken_fit_and_invalid_output_are_reported(self):
        document = self.document(20)
        for fit, label, message in [('raise RuntimeError("broken fit")', 0, 'broken fit'), ('pass', 2, '0 or 1')]:
            (self.root / 'pipeline.py').write_text(MODEL.format(fit=fit, label=label))
            with self.assertRaisesRegex(Exception, message):
                smoke(document)
        (self.root / 'pipeline.py').write_text(MODEL.format(fit='pass', label=0))
        smoke(document)
        result = outcome(document)
        self.assertTrue(result['passed'])
        self.assertEqual(result['sample'], {'trainRows': 20, 'testRows': 20})

    def test_sample_supports_ordinary_pipelines(self):
        # A KMeans with dozens of clusters or a min_df of 50 needs more than a handful of rows.
        document = self.document(3000)
        (self.root / 'pipeline.py').write_text(MODEL.format(fit='assert len(X) >= 200, "too few rows"', label=0))
        result = outcome(document)
        self.assertTrue(result['passed'])
        self.assertEqual(result['sample']['trainRows'], SAMPLE_ROWS[0])
        batch = self.document(3000, kind='clustering', execution='batch')
        (self.root / 'pipeline.py').write_text('class Model:\n def fit_predict(self, X):\n  assert len(X) >= 200\n  return [i % 40 for i in range(len(X))]\ndef build_pipeline(): return Model()\n')
        self.assertTrue(outcome(batch)['passed'])

    def test_sample_size_failures_are_identified(self):
        document = self.document(3000)
        (self.root / 'pipeline.py').write_text(MODEL.format(fit='assert len(X) > 1000, "needs more rows than the sample"', label=0))
        result = outcome(document)
        self.assertTrue(result['passed'])
        self.assertTrue(result['sampleSensitive'])
        self.assertEqual(result['phase'], 'fit')
        self.assertIn('needs more rows', result['error']['message'])
        self.assertTrue(result['largerSample']['passed'])
        # A real defect fails on both samples.
        (self.root / 'pipeline.py').write_text(MODEL.format(fit='raise RuntimeError("broken fit")', label=0))
        result = outcome(document)
        self.assertFalse(result['passed'])
        self.assertFalse(result['largerSample']['passed'])
        self.assertIn('broken fit', result['traceback'])
        # Output-contract failures are never retried.
        (self.root / 'pipeline.py').write_text(MODEL.format(fit='pass', label=2))
        result = outcome(document)
        self.assertEqual(result['phase'], 'output')
        self.assertNotIn('largerSample', result)


if __name__ == '__main__':
    unittest.main()
