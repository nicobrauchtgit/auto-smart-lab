"""Deterministic search adapter acceptance, with measured fixture fits and a fake clock."""
import contextlib
import dataclasses
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartlab_trial.artifacts import EventWriter
from smartlab_trial.folds import ConcreteFold
from smartlab_trial.invocation import Invocation, PipelineSpec, CvSpec, Scope, SearchSpec, RuntimeGuard
from smartlab_trial.search import run_search, write_search_outputs

class Search(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.folds = [ConcreteFold(repeat=0, fold=i, train=(0, 1), validation=(2, 3), seed=i) for i in range(3)]
        self.clock = 0.0
        self.inv = Invocation('fixture', 'test search', PipelineSpec('solutions/pipeline.py', 'build', {}),
            CvSpec('builtin', 1, 3, None, None, {}), Scope('promotion', None, None), self.root, self.root, 13, 17,
            search=SearchSpec({'quality': {'type': 'categorical', 'choices': [0, 1]}}, 'random', 12, True, None),
            runtime=RuntimeGuard(confirm_above_seconds=1000, max_seconds=1000),
            request={'pipeline': {}, 'cv': {'kind': 'builtin', 'scheme': 'stratified_kfold', 'folds': 3, 'repeats': 1}})

    def search(self, invocation=None, seconds=None, stop=None):
        inv = invocation or self.inv
        def fit(_inv, _factory, fold, *_args, **kwargs):
            measured = seconds(kwargs['estimator_index']) if seconds else 0.01
            self.clock += measured
            quality = kwargs['estimator_params']['quality']
            return ({'repeat': fold.repeat, 'fold': fold.fold, 'durationSeconds': measured,
                     'fitSeconds': measured, 'metrics': {'balancedAccuracy': quality}, 'convergence': {'available': True}}, [])
        with patch('smartlab_trial.search.time.monotonic', side_effect=lambda: self.clock), contextlib.redirect_stdout(io.StringIO()):
            return run_search(inv, EventWriter(self.root, 'fixture'), self.root, None, self.folds, None, [], [], stop or (lambda: False), fit)

    def test_pruned_configs_keep_fold_measurements_and_journal(self):
        outcome = self.search()
        pruned = [row for row in outcome['results'] if row.status == 'pruned']
        self.assertTrue(pruned)
        self.assertTrue(all(len(row.folds) < 3 and row.reason and row.folds for row in pruned))
        self.assertEqual(len(outcome['study'].trials), 12)
        self.assertTrue((self.root / 'study.journal').is_file())
        records = [json.loads(line) for line in (self.root / 'configs.jsonl').read_text().splitlines()]
        self.assertTrue(any(row['status'] == 'pruned' and row['foldScores'] for row in records))

    def test_threshold_stops_after_first_and_acknowledgement_runs(self):
        inv = dataclasses.replace(self.inv, runtime=RuntimeGuard(confirm_above_seconds=1, max_seconds=1000))
        outcome = self.search(inv, seconds=lambda _: 1)
        self.assertEqual(outcome['stopReason'], 'acknowledgement_required')
        self.assertEqual(len(outcome['results']), 1)
        self.assertEqual(outcome['guard']['basis']['secondsPerFit'], 1)
        self.assertEqual(outcome['results'][0].status, 'completed')

    def test_acknowledgement_covers_projection(self):
        inv = dataclasses.replace(self.inv, search=dataclasses.replace(self.inv.search, accept_seconds=100),
            runtime=RuntimeGuard(confirm_above_seconds=1, max_seconds=1000))
        self.assertIsNone(self.search(inv, seconds=lambda _: 1)['stopReason'])

    def test_overrun_keeps_completed_configurations(self):
        inv = dataclasses.replace(self.inv, search=dataclasses.replace(self.inv.search, accept_seconds=40, pruning=False),
            runtime=RuntimeGuard(confirm_above_seconds=1, max_seconds=1000))
        outcome = self.search(inv, seconds=lambda index: 1 if index == 0 else 10)
        self.assertEqual(outcome['stopReason'], 'overrun')
        self.assertEqual(len(outcome['results']), 2)
        self.assertTrue(all(row.status == 'completed' for row in outcome['results']))

    def test_hard_cap_stops_at_fold_boundary_and_keeps_measurements(self):
        inv = dataclasses.replace(self.inv, runtime=RuntimeGuard(confirm_above_seconds=1, max_seconds=2))
        outcome = self.search(inv, seconds=lambda _: 1)
        self.assertEqual(outcome['stopReason'], 'max_seconds')
        self.assertEqual(len(outcome['results'][0].folds), 2)
        self.assertEqual(outcome['results'][0].status, 'stopped')
        self.assertEqual(outcome['guard']['reason'], 'max_seconds')

    def test_grid_is_finite_and_deterministic(self):
        inv = dataclasses.replace(self.inv, search=dataclasses.replace(self.inv.search, sampler='grid', max_configs=40))
        outcome = self.search(inv)
        self.assertEqual(outcome['planned'], 2)
        self.assertEqual({row.params['quality'] for row in outcome['results']}, {0, 1})

    def test_journal_resume_retains_work_and_restores_sampler_sequence(self):
        inv = dataclasses.replace(self.inv, search=dataclasses.replace(self.inv.search, pruning=False),
            runtime=RuntimeGuard(confirm_above_seconds=1, max_seconds=1000))
        first = self.search(inv, seconds=lambda _: 1)
        self.assertEqual(len(first['results']), 1)
        inv = dataclasses.replace(inv, search=dataclasses.replace(inv.search, accept_seconds=100))
        resumed = self.search(inv, seconds=lambda _: 1)
        self.assertEqual(len(resumed['results']), 12)
        self.assertEqual(resumed['results'][0].folds, first['results'][0].folds)
        self.assertEqual(len(resumed['study'].trials), 12)
        previous = self.root
        self.root = Path(tempfile.mkdtemp())
        self.clock = 0
        fresh = self.search(dataclasses.replace(inv, output_dir=self.root), seconds=lambda _: 1)
        self.assertEqual([row.params for row in resumed['results']], [row.params for row in fresh['results']])
        self.assertEqual(len((previous / 'configs.jsonl').read_text().splitlines()), 12)

if __name__ == '__main__':
    unittest.main()
