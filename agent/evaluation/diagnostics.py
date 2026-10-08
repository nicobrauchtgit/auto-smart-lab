"""Read-only diagnostics from harness OOF evidence; never fit code.

Binary classification recomputes class metrics and score curves. Labelled
clustering recomputes each validation batch's adjusted Rand index; cluster IDs
are arbitrary per batch and never pooled across folds.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.metrics import (accuracy_score, balanced_accuracy_score, confusion_matrix,
                             precision_recall_fscore_support, roc_auc_score, roc_curve,
                             average_precision_score, precision_recall_curve)
from smartlab_eval import load_labels


def measure(rows, labels):
    truth = [labels[r['id']] for r in rows]
    pred = [int(r['prediction']) for r in rows]
    classes = sorted(set(labels.values()))
    precision, recall, f1, support = precision_recall_fscore_support(
        truth, pred, labels=classes, zero_division=0)
    result = {
        'rows': len(rows), 'accuracy': float(accuracy_score(truth, pred)),
        'balancedAccuracy': float(balanced_accuracy_score(truth, pred)),
        'macroF1': float(np.mean(f1)), 'labels': classes,
        'confusionMatrix': confusion_matrix(truth, pred, labels=classes).tolist(),
        'perClass': {str(c): {'precision': float(p), 'recall': float(r),
                             'f1': float(f), 'support': int(n)}
                     for c, p, r, f, n in zip(classes, precision, recall, f1, support)},
    }
    return result


def curves(rows, labels):
    if sorted(set(labels.values())) != [0, 1]:
        return {'available': False, 'reason': 'ROC/PR currently require binary labels 0 and 1.'}
    if any(r['score'] == '' for r in rows):
        return {'available': False, 'reason': 'Continuous scores are missing; labels are not ROC scores.'}
    truth = [labels[r['id']] for r in rows]
    if len(set(truth)) < 2:
        return {'available': False, 'reason': 'Only one class in this fold.'}
    scores = [float(r['score']) for r in rows]
    if not all(math.isfinite(s) for s in scores):
        raise ValueError('Non-finite OOF scores')
    fpr, tpr, _ = roc_curve(truth, scores)
    precision, recall, _ = precision_recall_curve(truth, scores)
    def points(x, y):
        indices = np.unique(np.linspace(0, len(x) - 1, min(101, len(x)), dtype=int))
        return [[float(x[i]), float(y[i])] for i in indices]
    return {'available': True, 'positiveLabel': 1,
            'rocAuc': float(roc_auc_score(truth, scores)),
            'averagePrecision': float(average_precision_score(truth, scores)),
            'positivePrevalence': float(np.mean(truth)),
            'roc': points(fpr, tpr), 'precisionRecall': points(recall, precision)}


def _checked_oof(directory, invocation, ids):
    """OOF rows that match the fold manifest exactly, one row per ID and repeat."""
    manifest = json.loads((directory / 'fold-manifest.json').read_text())
    with (directory / 'oof_predictions.csv').open(newline='') as stream:
        rows = list(csv.DictReader(stream, delimiter=';'))
    if not ids or not rows:
        raise ValueError('Empty development targets or OOF predictions')
    def key(r):
        return (r['id'], int(r['repeat']), int(r['fold']))
    observed = Counter(key(r) for r in rows)
    expected = Counter(key(r) for r in manifest['assignments'])
    if observed != expected or any(n != 1 for n in observed.values()):
        raise ValueError('OOF rows do not match the fold manifest exactly')
    repeats = sorted(set(int(r['repeat']) for r in rows))
    if repeats != list(range(invocation['request']['cv']['repeats'])):
        raise ValueError('OOF repeats do not match the requested scope')
    for repeat in repeats:
        counts = Counter(r['id'] for r in rows if int(r['repeat']) == repeat)
        if set(counts) != set(ids) or any(n != 1 for n in counts.values()):
            raise ValueError('Each repeat must cover every development ID exactly once')
    return rows, repeats


def diagnose_clustering(directory: Path, invocation):
    from sklearn.metrics import adjusted_rand_score, homogeneity_completeness_v_measure
    samples = json.loads(Path(invocation['measurement']['sampleManifestPath']).read_text())['samples']
    if any('target' not in sample for sample in samples):
        raise ValueError('Clustering review requires family targets for every development sample')
    targets = {sample['id']: str(sample['target']) for sample in samples}
    result = json.loads((directory / 'trial-result.json').read_text())
    rows, repeats = _checked_oof(directory, invocation, targets)
    folds = []
    for repeat, fold in sorted(set((int(r['repeat']), int(r['fold'])) for r in rows)):
        batch = [r for r in rows if int(r['repeat']) == repeat and int(r['fold']) == fold]
        truth, clusters = [targets[r['id']] for r in batch], [int(r['prediction']) for r in batch]
        homogeneity, completeness, v_measure = homogeneity_completeness_v_measure(truth, clusters)
        sizes = sorted(Counter(clusters).values(), reverse=True)
        folds.append({'repeat': repeat, 'fold': fold, 'rows': len(batch),
                      'adjustedRandIndex': float(adjusted_rand_score(truth, clusters)),
                      'homogeneity': float(homogeneity), 'completeness': float(completeness), 'vMeasure': float(v_measure),
                      'families': len(set(truth)), 'clusters': len(sizes), 'largestClusterShare': sizes[0] / len(batch),
                      'singletonClusters': sum(1 for size in sizes if size == 1),
                      'noiseFraction': sum(1 for c in clusters if c == -1) / len(batch)})
    scores = [f['adjustedRandIndex'] for f in folds]
    mean = float(np.mean(scores))
    if not math.isclose(mean, result['metrics']['adjustedRandIndex'], abs_tol=1e-10):
        raise ValueError('Recomputed adjusted Rand index disagrees with the harness result')
    family_sizes = Counter(targets.values())
    return {'schemaVersion': 1, 'experimentId': result['experimentId'], 'measurementKind': 'clustering',
            'summary': {'adjustedRandIndex': mean, 'rows': len(rows), 'uniqueRows': len(targets), 'repeats': len(repeats),
                        'execution': invocation['measurement']['execution'],
                        'families': len(family_sizes), 'largestFamily': max(family_sizes.values()),
                        'singletonFamilies': sum(1 for size in family_sizes.values() if size == 1),
                        'foldAdjustedRandIndex': {'min': min(scores), 'max': max(scores), 'mean': mean, 'std': float(np.std(scores))},
                        'singleFamilyBatches': sum(1 for f in folds if f['families'] < 2)},
            'curves': {'available': False, 'reason': 'Clustering assignments have no class scores; ROC/PR do not apply.'},
            'folds': folds,
            'limitations': [
                'Development cross-validation estimates, not held-out or deployment performance.',
                'ARI is computed per validation batch and averaged; cluster IDs are arbitrary within a batch and are never pooled.',
                'Batches with a single family give a degenerate ARI; their count is reported.',
                'Test families may differ from training families: only family-held-out folds approximate that shift.',
                'Model selection on these same folds can make the selected score optimistic.',
                'Artifact checks do not test feature leakage through IDs, paths or member names.',
            ]}


def diagnose_anomaly(directory: Path, invocation):
    # Import the measured score contract, not agent code.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'training' / 'python'))
    from smartlab_trial.measurement import load_samples, selection_receipt
    from smartlab_trial.anomaly_measurements import evidence
    spec = invocation['measurement']
    if not spec.get('selection'):
        raise ValueError('Anomaly review requires explicit selection evidence')
    frame, _, _ = load_samples(spec)
    rows, repeats = _checked_oof(directory, invocation, frame.id.tolist())
    metadata = frame.attrs['diagnosticEvidence']
    positions = {row_id: index for index, row_id in enumerate(frame.id)}
    result = json.loads((directory / 'trial-result.json').read_text())
    persisted = [json.loads(line) for line in (directory / 'fold-results.jsonl').read_text().splitlines() if line]
    folds = []
    for repeat, fold in sorted(set((int(r['repeat']), int(r['fold'])) for r in rows)):
        batch = [r for r in rows if int(r['repeat']) == repeat and int(r['fold']) == fold]
        validation = frame.iloc[[positions[row['id']] for row in batch]].reset_index(drop=True)
        measured = evidence(validation, np.asarray([float(row['score']) for row in batch]),
                            [int(row['prediction']) for row in batch], metadata, spec)
        receipt = selection_receipt(spec, measured)
        recorded = next(item for item in persisted if (item['repeat'], item['fold']) == (repeat, fold))
        if not receipt['available'] or receipt != recorded['selection'] or not math.isclose(receipt['value'], recorded['metrics']['selectionScore'], abs_tol=1e-12):
            raise ValueError('Recomputed evidence score differs from harness fold')
        folds.append({'repeat': repeat, 'fold': fold, 'selection': receipt, 'evidence': measured})
    mean = float(np.mean([fold['selection']['value'] for fold in folds]))
    if not math.isclose(mean, result['metrics']['selectionScore'], abs_tol=1e-12):
        raise ValueError('Recomputed selection mean differs from harness result')
    return {'schemaVersion': 1, 'experimentId': result['experimentId'], 'measurementKind': 'anomaly_detection',
            'summary': {'selectionScore': mean, 'selection': spec['selection'], 'source': metadata['source'],
                        'evidenceSha256': metadata['sha256'], 'uniqueRows': len(frame), 'labelledRows': len(metadata['labels']),
                        'positiveRows': sum(metadata['labels'].values()), 'negativeRows': len(metadata['labels']) - sum(metadata['labels'].values()),
                        'labelCoverage': len(metadata['labels']) / len(frame), 'repeats': len(repeats)},
            'folds': folds, 'limitations': ['Selection uses agent-provided evidence; labels are not verified by the harness.',
                'Partial coverage does not establish official accuracy or generalization to unfamiliar attacks.',
                'Evidence labels never enter estimator fitting; ranking AP does not choose the binary operating point.',
                'Adaptive evidence selection and the independent-fold noise approximation can make selection optimistic.']}


def diagnose(directory: Path):
    invocation = json.loads((directory / 'invocation.json').read_text())
    measurement = invocation.get('measurement')
    if measurement and measurement['kind'] == 'clustering':
        return diagnose_clustering(directory, invocation)
    if measurement and measurement['kind'] == 'anomaly_detection':
        return diagnose_anomaly(directory, invocation)
    if measurement and measurement['kind'] != 'classification':
        raise ValueError('Only labelled clustering and binary classification evidence can be reviewed')
    # The invocation points to development targets, never the original/sealed labels.
    if measurement:
        samples = json.loads(Path(measurement['sampleManifestPath']).read_text())['samples']
        labels = {sample['id']: sample['target'] for sample in samples}
        if len(labels) != len(samples) or any(value not in (0, 1) for value in labels.values()):
            raise ValueError('Development samples need unique IDs and 0/1 targets')
    else:
        labels_path = Path(invocation['inputs']['labelsPath'])
        labels = load_labels(labels_path)
        if len([line for line in labels_path.read_text().splitlines() if line.strip()]) != len(labels):
            raise ValueError('Duplicate development label IDs')
    result = json.loads((directory / 'trial-result.json').read_text())
    rows, repeats = _checked_oof(directory, invocation, labels)
    if any(r.get('score', '') != '' and not math.isfinite(float(r['score'])) for r in rows):
        raise ValueError('Non-finite OOF scores')
    if any(int(r['prediction']) not in set(labels.values()) for r in rows):
        raise ValueError('Predicted class is not a development label')
    summary = measure(rows, labels)
    if not math.isclose(summary['balancedAccuracy'], result['metrics']['balancedAccuracy'], abs_tol=1e-10):
        raise ValueError('Recomputed balanced accuracy disagrees with the harness result')
    folds = []
    for repeat, fold in sorted(set((int(r['repeat']), int(r['fold'])) for r in rows)):
        subset = [r for r in rows if int(r['repeat']) == repeat and int(r['fold']) == fold]
        folds.append({'repeat': repeat, 'fold': fold, **measure(subset, labels), 'curves': curves(subset, labels)})
    scores = [f['balancedAccuracy'] for f in folds]
    return {'schemaVersion': 1, 'experimentId': result['experimentId'],
            'summary': {**summary, 'uniqueRows': len(labels), 'repeats': len(repeats),
                        'classCounts': dict(Counter(str(y) for y in labels.values())),
                        'foldBalancedAccuracy': {'min': min(scores), 'max': max(scores),
                                                 'mean': float(np.mean(scores)), 'std': float(np.std(scores))}},
            'curves': curves(rows, labels), 'folds': folds,
            'limitations': [
                'Development cross-validation estimates, not held-out or deployment performance.',
                'Model selection on these same folds can make the selected score optimistic.',
                'Repeated OOF rows are correlated; fold spread is not a confidence interval.',
                'Pooled ROC/PR combine different fitted models; compare per-fold curves because score scales may differ.',
                'Score provenance does not distinguish probabilities from margins; no calibration claim is supported.',
                'No demographic/group attributes supplied: class recall differences do not establish demographic fairness.',
                'Artifact checks do not test feature leakage, duplicate-text leakage, or group/time split suitability.',
            ]}


if __name__ == '__main__':
    print(json.dumps(diagnose(Path(sys.argv[1])), allow_nan=False))
