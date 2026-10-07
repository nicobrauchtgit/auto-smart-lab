"""Validate and reuse harness checkpoints before any fit (including custom CV)."""
import hashlib
import json
import math
from pathlib import Path

from .artifacts import _atomic_json
from .folds import ConcreteFold, _manifest, _as_indices, _validate_coverage
from .invocation import InvocationError


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def save_checkpoint(path, value):
    _atomic_json(path, {**value, 'checkpointSha256': digest(value)})


def load_checkpoint(path):
    value = json.loads(path.read_text())
    checksum = value.pop('checkpointSha256', None)
    if checksum != digest(value):
        raise InvocationError(f'Corrupt or legacy checkpoint {path}: restore the original checksummed checkpoint; no fit started')
    return value


def persisted_folds(invocation, ids):
    path = invocation.output_dir / 'fold-manifest.json'
    if not path.exists():
        if any((invocation.output_dir / name).exists() for name in ('search-checkpoint.json', 'single-checkpoint.json', 'study.journal')):
            raise InvocationError('Missing fold-manifest.json for existing progress; restore the original manifest before resuming')
        return None
    value = json.loads(path.read_text())
    folds = []
    for row in value['folds']:
        train = _as_indices(row['trainIndices'], 'saved train', len(ids))
        validation = _as_indices(row['validationIndices'], 'saved validation', len(ids))
        if set(train) & set(validation):
            raise InvocationError('Saved train/validation overlap; restore fold manifest')
        folds.append(ConcreteFold(row['repeat'], row['fold'], train, validation, row['seed']))
    if not folds or len({(f.repeat, f.fold) for f in folds}) != len(folds):
        raise InvocationError('Empty or duplicate saved folds; restore fold manifest')
    _validate_coverage(folds, len(ids), invocation.cv.repeats, invocation.scope.kind == 'promotion')
    expected = _manifest(invocation.experiment_id, ids, folds, invocation.scope, invocation.trial_seed)
    if value != expected:
        raise InvocationError('Incompatible/corrupt fold manifest: dataset, experiment, seed or checksum differs; restore original inputs')
    return folds, value


def validate_single(value, invocation, manifest, folds, ids):
    if value['experimentId'] != invocation.experiment_id or value['manifestSha256'] != manifest['sha256']:
        raise InvocationError('Single-trial checkpoint identity/manifest mismatch; restore original checkpoint')
    completed, rows = value['completed'], value['oof']
    if len(completed) > len(folds):
        raise InvocationError('Too many completed folds in checkpoint')
    for measured, fold in zip(completed, folds):
        if (measured['repeat'], measured['fold'], measured['seed']) != (fold.repeat, fold.fold, fold.seed):
            raise InvocationError('Single-trial completed fold order/seed mismatch')
    expected = [(ids[i], f.repeat, f.fold) for f in folds[:len(completed)] for i in f.validation]
    if [(r['id'], r['repeat'], r['fold']) for r in rows] != expected:
        raise InvocationError('Single-trial saved predictions do not match completed folds; restore checkpoint')
    return completed, rows
