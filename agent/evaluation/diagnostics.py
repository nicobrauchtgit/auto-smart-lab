"""Read-only classification diagnostics from harness OOF evidence; never fit code."""
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


def diagnose(directory: Path):
    invocation = json.loads((directory / 'invocation.json').read_text())
    # The invocation points to development labels, never the original/sealed labels.
    labels_path = Path(invocation['inputs']['labelsPath'])
    labels = load_labels(labels_path)
    if len([line for line in labels_path.read_text().splitlines() if line.strip()]) != len(labels):
        raise ValueError('Duplicate development label IDs')
    manifest = json.loads((directory / 'fold-manifest.json').read_text())
    result = json.loads((directory / 'trial-result.json').read_text())
    with (directory / 'oof_predictions.csv').open(newline='') as stream:
        rows = list(csv.DictReader(stream, delimiter=';'))
    if not labels or not rows:
        raise ValueError('Empty development labels or OOF predictions')
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
        if set(counts) != set(labels) or any(n != 1 for n in counts.values()):
            raise ValueError('Each repeat must cover every development ID exactly once')
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
