"""Small execution checks for trial_smoke."""
import json
import tempfile
import unittest
from pathlib import Path
from smoke import smoke

class SmokeTests(unittest.TestCase):
    def test_broken_fit_and_invalid_output_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'samples.json'
            manifest.write_text(json.dumps(dict(schemaVersion=1, samples=[dict(id=str(i), input={}, target=i % 2) for i in range(20)])))
            document = dict(sourceRoot=str(root), request=dict(pipeline=dict(module='pipeline.py', factory='build_pipeline')), measurement=dict(kind='classification', execution='inductive', sampleManifestPath=str(manifest)))
            for body, message in [('raise RuntimeError("broken fit")', 'broken fit'), ('return self', '0 or 1')]:
                (root / 'pipeline.py').write_text('class Model:\n def fit(self, X, y):\n  '+body+'\n def predict(self, X): return [2] * len(X)\ndef build_pipeline(): return Model()\n')
                with self.assertRaisesRegex(Exception, message): smoke(document)
            (root / 'pipeline.py').write_text('class Model:\n def fit(self, X, y): return self\n def predict(self, X): return [0] * len(X)\ndef build_pipeline(): return Model()\n')
            smoke(document)
if __name__ == '__main__': unittest.main()
