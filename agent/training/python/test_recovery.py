"""No-fit refusal and persisted fold acceptance tests."""
import dataclasses
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from smartlab_trial.recovery import save_checkpoint, load_checkpoint, persisted_folds
from smartlab_trial.folds import ConcreteFold, _manifest
from smartlab_trial.invocation import Invocation, PipelineSpec, CvSpec, Scope, SearchSpec, RuntimeGuard
from smartlab_trial.artifacts import _atomic_json, EventWriter
from smartlab_trial.search import run_search

class Recovery(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.folds = [ConcreteFold(0, 0, (0, 1), (2, 3), 17)]
        self.ids = ['a', 'b', 'c', 'd']
        self.inv = Invocation('fixture', 'test', PipelineSpec('solutions/a.py', 'build', {}),
            CvSpec('builtin', 1, 2, None, None, {}), Scope('pilot', None, 1), self.root, self.root, 13, 17,
            search=SearchSpec({'quality': {'type': 'categorical', 'choices': [0, 1]}}, 'random', 2, False, None),
            runtime=RuntimeGuard(confirm_above_seconds=100, max_seconds=100), request={})

    def test_checkpoint_tampering_is_refused(self):
        path = self.root / 'checkpoint.json'
        save_checkpoint(path, {'results': [], 'elapsedSeconds': 2})
        value = json.loads(path.read_text()); value['elapsedSeconds'] = 0; path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'Corrupt or legacy checkpoint'):
            load_checkpoint(path)

    def test_existing_manifest_used_without_recalling_custom_splitter(self):
        manifest = _manifest('fixture', self.ids, self.folds, self.inv.scope, 17)
        _atomic_json(self.root / 'fold-manifest.json', manifest)
        folds, value = persisted_folds(self.inv, self.ids)
        self.assertEqual(folds, self.folds); self.assertEqual(value, manifest)

    def test_manifest_changed_data_seed_and_corruption_refused(self):
        manifest = _manifest('fixture', self.ids, self.folds, self.inv.scope, 17)
        _atomic_json(self.root / 'fold-manifest.json', manifest)
        for inv, ids in [(dataclasses.replace(self.inv, trial_seed=19), self.ids), (self.inv, ['changed', 'b', 'c', 'd'])]:
            # The changed training-only ID is absent from assignments, so change a validation ID too.
            if inv is self.inv: ids = ['a', 'b', 'changed', 'd']
            with self.assertRaisesRegex(ValueError, 'Incompatible/corrupt'):
                persisted_folds(inv, ids)
        manifest['sha256'] = 'bad'; _atomic_json(self.root / 'fold-manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Incompatible/corrupt'):
            persisted_folds(self.inv, self.ids)

    def test_partial_journal_refused_before_fit(self):
        (self.root / 'study.journal').write_text('{"op_code":')
        fit = unittest.mock.Mock(side_effect=AssertionError('must not fit'))
        with self.assertRaisesRegex(ValueError, 'Corrupt study.journal'):
            run_search(self.inv, EventWriter(self.root, 'fixture'), self.root, None, self.folds, None, [], [], lambda: False, fit)
        fit.assert_not_called()

    def test_hard_cap_is_cumulative_across_restart_and_never_adds_fit(self):
        _atomic_json(self.root / 'recovery-runtime.json', {'consumedSeconds': 101})
        fit = unittest.mock.Mock(side_effect=AssertionError('must not fit'))
        outcome = run_search(self.inv, EventWriter(self.root, 'fixture'), self.root, None, self.folds, None, [], [], lambda: False, fit)
        self.assertEqual(outcome['stopReason'], 'max_seconds'); fit.assert_not_called()

    def test_corrupt_runtime_refused_before_fit(self):
        _atomic_json(self.root / 'recovery-runtime.json', {'consumedSeconds': -1})
        fit = unittest.mock.Mock(side_effect=AssertionError('must not fit'))
        with self.assertRaisesRegex(ValueError, 'runtime accounting'):
            run_search(self.inv, EventWriter(self.root, 'fixture'), self.root, None, self.folds, None, [], [], lambda: False, fit)
        fit.assert_not_called()

    def test_stale_old_optuna_symlink_lock_does_not_block_kernel_owned_search(self):
        (self.root / "study.journal.lock").symlink_to(self.root / "study.journal")
        _atomic_json(self.root / "recovery-runtime.json", {"consumedSeconds": 101})
        fit = unittest.mock.Mock(side_effect=AssertionError("must not fit"))
        outcome = run_search(self.inv, EventWriter(self.root, "fixture"), self.root, None, self.folds, None, [], [], lambda: False, fit)
        self.assertEqual(outcome["stopReason"], "max_seconds")
        fit.assert_not_called()
