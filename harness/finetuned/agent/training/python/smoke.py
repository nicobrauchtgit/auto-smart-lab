"""Cheap pipeline execution before a charged trial.
Input: typed request, development manifest and optional test archive; output:
a structured outcome (phase, error, sample sizes). The harness renders the
agent-facing wording from its prompt registry.
"""
import contextlib
import json
import sys
import traceback
import multiprocessing
import os
from smartlab_trial.batch import batch_fit_predict, load_anchor
from smartlab_trial.diagnostics import clustering
from smartlab_trial.anomaly_domain import decision_domain_reason
from pathlib import Path
import numpy as np
import pandas as pd
from smartlab_trial.agent_code import expose_project, _load_module, _factory, _call_pipeline_factory, _inject_random_states
from smartlab_trial.measurement import load_samples

# Large enough for ordinary pipelines (dozens of clusters, min_df thresholds,
# inner CV), small enough to stay a quick check. A failure on the first sample
# is retried once on the larger one to tell sample-size limits from defects.
SAMPLE_ROWS = (256, 2048)


class SmokeFailure(Exception):
    def __init__(self, phase, error):
        super().__init__(str(error))
        self.phase, self.error = phase, error


def _sample(frame, targets, measurement, rows):
    """Fixed, class-balanced development rows; no scoring evidence is returned."""
    if targets is not None and measurement['kind'] == 'classification':
        classes = sorted(set(targets), key=str)
        per_class = max(1, rows // len(classes))
        return [i for value in classes for i in [i for i, y in enumerate(targets) if y == value][:per_class]]
    return list(range(min(rows, len(frame))))


def _test_frame(document, frame, rows):
    test_zip = document.get('testZip')
    if test_zip:
        from task_samples import sample_descriptors
        return pd.DataFrame(sample_descriptors(test_zip, document.get('sampleSource') or 'zip_members')[:rows])
    return frame.iloc[:min(rows, len(frame))].copy()


def _run(document, root, frame, targets, rows):
    request, measurement = document['request'], document['measurement']
    indices = _sample(frame, targets, measurement, rows)
    train = frame.iloc[indices].reset_index(drop=True)
    train.attrs.clear()
    test = _test_frame(document, frame, rows)
    test.attrs.clear()
    before = test['id'].tolist()
    sizes = {'trainRows': len(train), 'testRows': len(test)}
    pipeline = request['pipeline']
    try:
        estimator = _call_pipeline_factory(_factory(_load_module(root, pipeline['module']), pipeline['factory']),
                                           dict(parameters=pipeline.get('parameters', {}), seed=0, measurement=measurement))
        if pipeline.get('estimatorParams'):
            estimator.set_params(**pipeline['estimatorParams'])
        _inject_random_states(estimator, 0)
    except BaseException as error:
        raise SmokeFailure('build', error) from error
    batch_decisions = measurement['execution'] == 'batch' and callable(getattr(estimator, 'fit_predict', None))
    phase = 'fit'
    try:
        if measurement['kind'] == 'classification':
            estimator.fit(train, [targets[i] for i in indices])
            phase = 'predict'
            predictions = estimator.predict(test)
        elif measurement['execution'] == 'batch' and callable(getattr(estimator, 'fit_predict', None)):
            predictions = estimator.fit_predict(test)
        else:
            estimator.fit(train)
            phase = 'predict'
            method = measurement.get('scoreMethod', 'predict')
            predictions = getattr(estimator, method)(test)
    except BaseException as error:
        raise SmokeFailure(phase, error) from error
    values = np.asarray(predictions)
    try:
        if values.shape != (len(test),) or not np.isfinite(values.astype(float)).all():
            raise ValueError('Smoke predictions must be finite and row aligned')
        if measurement['kind'] == 'classification' and not np.isin(values, [0, 1]).all():
            raise ValueError('Smoke binary predictions must be 0 or 1')
        if measurement['kind'] == 'clustering' and not np.equal(values, np.floor(values)).all():
            raise ValueError('Smoke cluster labels must be integers')
        if test['id'].tolist() != before or len(set(before)) != len(before):
            raise ValueError('Smoke input IDs were changed or duplicated')
    except ValueError as error:
        raise SmokeFailure('output', error) from error
    if measurement['kind'] == 'anomaly_detection' and (batch_decisions or callable(getattr(estimator, 'predict', None))):
        try:
            decisions = values if batch_decisions else np.asarray(estimator.predict(test))
        except BaseException as error:
            raise SmokeFailure('predict', error) from error
        try:
            if decisions.shape != (len(test),) or not np.isfinite(decisions.astype(float)).all():
                raise ValueError('Smoke decisions must be finite and row aligned')
            label = measurement['anomalyLabel']
            reason = decision_domain_reason(decisions, label)
            if reason:
                raise ValueError(reason)
            if len(decisions) and (np.all(decisions != label) or np.all(decisions == label)):
                sizes['anomalyDecision'] = {'label': label, 'frequency': 'never' if np.all(decisions != label) else 'always'}
        except BaseException as error:
            raise SmokeFailure('output', error) from error
    return sizes


def smoke(document):
    """Run the pipeline on a small sample; raise SmokeFailure with the outcome on failure."""
    root = Path(document['sourceRoot']).resolve()
    expose_project(root)
    frame, targets, _ = load_samples(document['measurement'])
    return _run(document, root, frame, targets, SAMPLE_ROWS[0])


def anchored_structure(document, root, frame):
    measurement = document['measurement']
    if measurement['kind'] != 'clustering' or measurement['execution'] != 'batch' or not measurement.get('anchorManifestPath'):
        return None
    # A separate process enforces wall time even while native estimator code blocks.
    # Spawn starts a fresh OpenMP runtime; fork can deadlock after the base fit.
    context = multiprocessing.get_context('spawn')
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=_anchored_child, args=(writer, document, root, frame))
    process.start()
    writer.close()
    try:
        if reader.poll(document.get('anchorTimeoutSeconds', 10)):
            return reader.recv()
        return {'available': False, 'reason': 'Timeout'}
    except EOFError:
        return {'available': False, 'reason': 'Worker exited'}
    finally:
        if process.is_alive():
            process.kill()
        process.join(timeout=1)
        reader.close()


def _anchored_child(writer, document, root, frame):
    # Agent output goes to stderr, as in the parent; stdout carries only the final JSON line.
    os.dup2(2, 1)
    try:
        expose_project(root)
        writer.send(_anchored_structure(document, root, frame))
    finally:
        writer.close()


def _anchored_structure(document, root, frame):
    measurement = document['measurement']
    try:
        anchor = load_anchor(measurement, frame)
        count = document.get('sealedRows')
        if not isinstance(count, int) or count < 1:
            return {'available': False, 'reason': 'No sealed-sized block available'}
        indices = np.random.default_rng(0).permutation(len(frame))[:count]
        labelled = frame.iloc[indices].reset_index(drop=True)
        labelled.attrs.clear()
        pipeline = document['request']['pipeline']
        estimator = _call_pipeline_factory(_factory(_load_module(root, pipeline['module']), pipeline['factory']),
            dict(parameters=pipeline.get('parameters', {}), seed=0, measurement=measurement))
        if pipeline.get('estimatorParams'):
            estimator.set_params(**pipeline['estimatorParams'])
        _inject_random_states(estimator, 0)
        _, predictions = batch_fit_predict(estimator, labelled, anchor)
        return {'available': True, **clustering(None, predictions)['structure']}
    except Exception as error:
        return {'available': False, 'reason': 'Timeout' if isinstance(error, TimeoutError) else type(error).__name__}


def outcome(document):
    """Structured result: passed, sizes, and for failures phase/error/traceback and sample sensitivity."""
    root = Path(document['sourceRoot']).resolve()
    expose_project(root)
    frame, targets, _ = load_samples(document['measurement'])
    result = {'developmentRows': len(frame)}
    try:
        result.update(passed=True, sample=_run(document, root, frame, targets, SAMPLE_ROWS[0]))
        test_part = anchored_structure(document, root, frame)
        if test_part is not None:
            result['testPart'] = test_part
        return result
    except SmokeFailure as failure:
        first = failure
        first_trace = traceback.format_exc()[-8000:]
    small = {'trainRows': len(_sample(frame, targets, document['measurement'], SAMPLE_ROWS[0]))}
    result.update(passed=False, phase=first.phase, error={'type': type(first.error).__name__, 'message': str(first.error)[:2000]},
                  traceback=first_trace, sample=small)
    # Output-contract and build failures do not depend on the sample size.
    if first.phase in ('fit', 'predict') and small['trainRows'] < min(len(frame), SAMPLE_ROWS[1]):
        try:
            larger = _run(document, root, frame, targets, SAMPLE_ROWS[1])
        except SmokeFailure:
            result['largerSample'] = {'passed': False, 'trainRows': len(_sample(frame, targets, document['measurement'], SAMPLE_ROWS[1]))}
        else:
            # Only the small sample failed: the cause is its size, not the pipeline.
            result.update(passed=True, sampleSensitive=True, largerSample={'passed': True, **larger})
            test_part = anchored_structure(document, root, frame)
            if test_part is not None:
                result['testPart'] = test_part
    return result


if __name__ == '__main__':
    document = json.load(sys.stdin)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            value = outcome(document)
    except BaseException as error:
        value = {'passed': False, 'phase': 'load', 'error': {'type': type(error).__name__, 'message': str(error)[:2000]},
                 'traceback': traceback.format_exc()[-8000:]}
    print(json.dumps(value))
