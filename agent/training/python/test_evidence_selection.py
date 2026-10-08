"""Scoring-only evidence selection, immutable identities and terminal recomputation."""
import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import shutil
import unittest
from pathlib import Path

import test_measurements
from smartlab_trial.measurement import load_samples, selection_receipt, validate_config
from smartlab_trial.invocation import InvocationError


class EvidenceSelection(unittest.TestCase):
    def setUp(self):
        self.base = test_measurements.MeasurementWorker()
        self.base.setUp()
        self.fixture = self.base.fixture
        self.addCleanup(shutil.rmtree, self.fixture.root)

    def execute(self, document):
        return self.base.execute(document)

    def document(self, *args, **kwargs):
        document = self.base.document('anomaly_detection', targets=False, execution='inductive')
        path = self.fixture.root / 'evidence.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'labels': [
            {'id': f'sample-{i:03d}', 'target': int(i % 6 > 1)} for i in range(48) if i % 6 != 5]}))
        document['measurement'].update(evidence={'path': str(path), 'source': 'agent_provided'},
            evidenceManifestSha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            selection={'basis': 'evidence', 'metric': 'evidence_average_precision', 'direction': 'maximize', 'population': 'development'})
        return document

    # Do not inherit the generic task tests: they construct different task kinds.
    def test_evidence_score_promotes_without_fit_targets_and_retains_coverage(self):
        doc = self.document()
        module = self.fixture.root / 'solutions/generic.py'
        module.write_text(module.read_text().replace('assert y is None,', 'assert not frame.attrs\n        assert y is None,'))
        result = self.execute(doc)
        self.assertTrue(result['promotionEligible'])
        self.assertEqual(result['metrics'], {'selectionScore': 1})
        self.assertEqual(result['selection']['source'], 'agent_provided')
        self.assertTrue(all(0 < fold['labelCoverage'] < 1 for fold in result['selection']['folds']))
        self.assertTrue(all(fold['positiveRows'] and fold['negativeRows'] for fold in result['selection']['folds']))

    def test_one_class_and_empty_folds_never_fallback_or_promote(self):
        doc = self.document()
        path = Path(doc['measurement']['evidence']['path'])
        path.write_text(json.dumps({'schemaVersion': 1, 'labels': [{'id': 'sample-000', 'target': 1}]}))
        doc['measurement']['evidenceManifestSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        result = self.execute(doc)
        self.assertFalse(result['promotionEligible'])
        self.assertIsNone(result['metrics'])
        self.assertEqual(result['promotionIneligibleReason'], 'incomplete_selection_evidence')

    def test_snapshot_mutation_prevents_resume_before_agent_code(self):
        doc = self.document()
        self.execute(doc)
        path = Path(doc['measurement']['evidence']['path'])
        path.write_text('{}')
        (self.fixture.root / 'solutions/generic.py').write_text("raise AssertionError('imported agent')")
        with self.assertRaisesRegex(InvocationError, 'Evidence manifest changed'):
            self.execute(doc)

    def test_custom_cv_receives_no_evidence_labels(self):
        doc = self.document()
        path = self.fixture.root / 'solutions/evidence_cv.py'
        path.write_text("def make_cv(context):\n    assert not context['frame'].attrs and context['y'] is None\n    n = len(context['frame']); h = n // 2\n    return [(list(range(h,n)), list(range(h))), (list(range(h)), list(range(h,n)))]\n")
        doc['request']['cv'] = {'kind': 'factory', 'module': 'solutions/evidence_cv.py', 'factory': 'make_cv', 'repeats': 1}
        self.assertTrue(self.execute(doc)['promotionEligible'])

    def test_no_implicit_direction_population_or_generated_assets(self):
        doc = self.document()
        for changes in ({'direction': 'minimize'}, {'population': 'challenge'}, {'basis': 'proxy'}):
            bad = {**doc['measurement'], 'selection': {**doc['measurement']['selection'], **changes}}
            with self.assertRaises(InvocationError):
                validate_config(bad)
        path = Path(doc['measurement']['evidence']['path'])
        path.write_text(json.dumps({'schemaVersion': 1, 'labels': [{'id': 'unknown-generated.png', 'target': 1}]}))
        doc['measurement']['evidenceManifestSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(InvocationError, 'known development IDs'):
            load_samples(doc['measurement'])

    def test_search_uses_explicit_selection_and_still_requires_confirmation(self):
        doc = self.document()
        doc['request']['schemaVersion'] = 2
        doc['schemaVersion'] = 2
        doc['request']['search'] = {'space': {'mode': {'type': 'categorical', 'choices': ['anomaly']}}, 'sampler': 'grid'}
        result = self.execute(doc)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['metrics']['selectionScore'], 1)
        self.assertFalse(result['promotionEligible'])
        self.assertEqual(result['search']['selectionMean'], 1)

    def test_refit_and_evaluation_recompute_frozen_evidence_and_detect_corrupt_scores(self):
        doc = self.document()
        # Terminal evidence validators require a source identity, but never import it.
        doc['schemaVersion'] = 2
        doc['request']['schemaVersion'] = 2
        doc['source'] = {'commit': 'a' * 40, 'tree': 'b' * 40}
        # parse_invocation requires a fully bound versioned source.
        doc['source'].update(repository=str(self.fixture.root / 'solutions'))
        result = self.execute(doc)
        directory = self.fixture.root / 'generic'
        (directory / 'invocation.json').write_text(json.dumps(doc))
        for name, path in [('refit_evidence_test', Path(__file__).resolve().parents[2] / 'refit/evidence.py'),
                           ('evaluation_evidence_test', Path(__file__).resolve().parents[2] / 'evaluation/diagnostics.py')]:
            spec = importlib.util.spec_from_file_location(name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if name.startswith('refit'):
                module.validate(directory)
            else:
                review = module.diagnose(directory)
                self.assertEqual(review['summary']['selectionScore'], 1)
                self.assertEqual(review['summary']['labelledRows'], 40)
        fold_path = directory / 'fold-results.jsonl'
        folds = [json.loads(line) for line in fold_path.read_text().splitlines()]
        folds[0]['metrics']['selectionScore'] = .25
        fold_path.write_text(''.join(json.dumps(fold) + '\n' for fold in folds))
        with self.assertRaisesRegex(ValueError, 'differs'):
            module.diagnose(directory)

