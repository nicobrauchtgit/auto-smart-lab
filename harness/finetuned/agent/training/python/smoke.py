"""Cheap pipeline execution before a charged trial.
Input: typed request, development manifest and optional test archive; output: issues.
"""
import contextlib
import json
import sys
import traceback
import zipfile
from pathlib import Path
import numpy as np
import pandas as pd
from smartlab_trial.agent_code import expose_project, _load_module, _factory, _call_pipeline_factory, _inject_random_states
from smartlab_trial.measurement import load_samples


def smoke(document):
    root = Path(document['sourceRoot']).resolve()
    expose_project(root)
    request, measurement = document['request'], document['measurement']
    frame, targets, _ = load_samples(measurement)
    # Fixed, balanced small sample; no scoring evidence is returned.
    indices = []
    if targets is not None:
        for value in sorted(set(targets), key=str):
            indices.extend([i for i, y in enumerate(targets) if y == value][:8])
    else:
        indices = list(range(min(16, len(frame))))
    train = frame.iloc[indices].reset_index(drop=True)
    train.attrs.clear()
    test_zip = document.get('testZip')
    if test_zip:
        with zipfile.ZipFile(test_zip) as archive:
            names = sorted(x.filename for x in archive.infolist() if not x.is_dir())[:8]
        test = pd.DataFrame([dict(id=name, input=dict(archive=test_zip, member=name)) for name in names])
    else:
        test = frame.iloc[:min(8, len(frame))].copy()
    test.attrs.clear()
    before = test['id'].tolist()
    pipeline = request['pipeline']
    estimator = _call_pipeline_factory(_factory(_load_module(root, pipeline['module']), pipeline['factory']), dict(parameters=pipeline.get('parameters', {}), seed=0, measurement=measurement))
    if pipeline.get('estimatorParams'): estimator.set_params(**pipeline['estimatorParams'])
    _inject_random_states(estimator, 0)
    if measurement['kind'] == 'classification':
        estimator.fit(train, [targets[i] for i in indices])
        predictions = estimator.predict(test)
    elif measurement['execution'] == 'batch' and callable(getattr(estimator, 'fit_predict', None)):
        predictions = estimator.fit_predict(test)
    else:
        estimator.fit(train)
        method = measurement.get('scoreMethod', 'predict')
        predictions = getattr(estimator, method)(test)
    values = np.asarray(predictions)
    if values.shape != (len(test),) or not np.isfinite(values.astype(float)).all():
        raise ValueError('Smoke predictions must be finite and row aligned')
    if measurement['kind'] == 'classification' and not np.isin(values, [0, 1]).all():
        raise ValueError('Smoke binary predictions must be 0 or 1')
    if measurement['kind'] == 'clustering' and not np.equal(values, np.floor(values)).all():
        raise ValueError('Smoke cluster labels must be integers')
    if test['id'].tolist() != before or len(set(before)) != len(before):
        raise ValueError('Smoke input IDs were changed or duplicated')

if __name__ == '__main__':
    document = json.load(sys.stdin)
    issues = []
    try:
        with contextlib.redirect_stdout(sys.stderr): smoke(document)
    except BaseException:
        issues.append(dict(path='pipeline', problem='smoke failed', received=document['request']['pipeline'], expected='small fit and valid row-aligned predictions', hint='Fix the traceback; no trial was charged.', message=traceback.format_exc()[-8000:]))
    print(json.dumps(dict(issues=issues)))
