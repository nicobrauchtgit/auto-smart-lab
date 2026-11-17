"""User-authorized (2026-11-17): resume the failed code3 finetuned lead run in place with its remaining
tool calls. Runs only after workflow_code.py finished (state code_attacks_complete)."""
from pathlib import Path
import shutil
source = Path(__file__).with_name('workflow.py').read_text()
prefix, separator, _ = source.partition("if (HERE/'WAIT_FOR_GO').exists():raise SystemExit")
assert separator, "Observer helper boundary missing"
exec(prefix, globals())
task, arm, fmt = 'code3', 'finetuned', 'win'
data = ROOT / 'units/clustering-of-malicious-code/malicious-code-for-windows/data'
progress_path = ROOT / 'runs/finetuned/code3/lead/PROGRESS.json'
try:
    state = json.loads(STATE.read_text())
    assert state['state'] in ('code_attacks_complete', 'resume_code3'), 'workflow_code.py has not finished'
    assert not active_runtime(), 'An owned runtime is already active'
    update(state='resume_code3', nextTask=task, currentArm=arm, startedAt=now())
    # 1. Same Windows data as the original run.
    staged = {f['split']: f for f in json.loads((HERE / 'staging-win/staging.json').read_text())['files']}
    if not all((data / f'win-{s}.zip').is_file() for s in ('train', 'test')):
        shutil.copy(HERE / 'staging-win/staging.json', HERE / 'staging-win/staging-original.json') if not (HERE / 'staging-win/staging-original.json').exists() else None
        run(['./dev', 'python', str(HERE / 'stage_code.py'), fmt], 'win-restaging.log')
    original = {f['split']: f for f in json.loads((HERE / ('staging-win/staging-original.json' if (HERE / 'staging-win/staging-original.json').exists() else 'staging-win/staging.json')).read_text())['files']}
    for s in ('train', 'test'):
        assert hashfile(data / f'win-{s}.zip') == original[s]['sha256'], f'win-{s}.zip differs from the original staging'
    # 2. Keep the failed attempt's records, then mark the lead run interrupted so the harness resumes it.
    attempt = HERE / task / 'finetuned-attempt1'
    if not attempt.exists(): shutil.copytree(HERE / task / arm, attempt)
    saved = progress_path.with_name('PROGRESS.failed-attempt1.json')
    progress = json.loads(progress_path.read_text())
    if progress['status'] == 'failed':
        if not saved.exists(): saved.write_text(json.dumps(progress, indent=2) + '\n')
        progress['status'] = 'running'
        progress_path.write_text(json.dumps(progress, indent=2) + '\n')
    assert json.loads(progress_path.read_text())['status'] == 'running'
    note(f'code3 finetuned resume: data hashes match the original staging; failed-attempt records kept; PROGRESS.json set from failed to running ({progress["budget"]["used"]} of {progress["budget"]["limit"]} calls used).')
    # 3. Preflight, resumed run, verification, backup, cleanup.
    run(['./dev', 'bun', 'run', 'experiment', '--', '--arm', arm, '--no-fetch', '--check-setup', task], f'{task}-{arm}-resume-preflight.log')
    update(state='running', currentArm=arm)
    run(['./dev', 'bun', str(HERE / 'controller.ts'), arm, task, 'resume'], f'{task}-{arm}-resume-controller.log')
    controller = json.loads((HERE / task / arm / 'status.json').read_text()); assert controller['state'] == 'succeeded'
    row = controller['tasks'][-1]; assert row['validated']; output = Path(row['delivery'])
    manifest = json.loads((output.parent / 'manifest.json').read_text())
    with zipfile.ZipFile(data / 'win-test.zip') as z: expected = {i.filename for i in z.infolist() if not i.is_dir()}
    lines = [line.rsplit(';', 1) for line in output.read_text().splitlines()]; ids = [line[0] for line in lines]
    assert len(ids) == len(set(ids)) == len(expected) == manifest['lines'] and set(ids) == expected, 'Delivery IDs differ from the test archive'
    assert all(len(line) == 2 and line[1].lstrip('-').isdigit() for line in lines), 'Prediction domain'
    assert hashfile(output) == manifest['sha256'] and manifest['task'] == task
    with zipfile.ZipFile(output.parent / 'source.zip') as z: assert z.testzip() is None and z.infolist()
    (HERE / task / arm / 'verified-delivery.json').write_text(json.dumps({'at': now(), 'task': task, 'arm': arm, 'verified': True, 'resumed': True, 'rows': len(ids), 'output': str(output), 'outputSHA256': hashfile(output), 'sourceSHA256': hashfile(output.parent / 'source.zip')}, indent=2) + '\n')
    note(f'code3 finetuned (resumed): delivered {len(ids)} predictions; exact IDs, domain, hashes and source ZIP checks passed.')
    update(state='backing_up', currentArm=arm)
    run(['./dev', 'python', str(HERE / 'backup_task.py'), task, arm], f'{task}-{arm}-resume-backup.log')
    backup = json.loads((HERE / task / 'backup-finetuned/status.json').read_text()); assert backup['state'] == 'verified'
    state = json.loads(STATE.read_text())
    completed = [x if not (x['task'] == task and x['arm'] == arm) else {**x, 'outcome': 'delivered_after_resume', 'verifiedAt': now()} for x in state['completedTasks']]
    update(completedTasks=completed)
    note('code3 finetuned (resumed): private Drive round-trip verified; ' + backup['folder'].get('webViewLink', backup['folder']['id']))
    removed = [{'path': str(p.relative_to(ROOT)), 'bytes': p.stat().st_size, 'sha256': hashfile(p)} for p in sorted(data.iterdir()) if p.is_file()]
    with (HERE / 'dataset-cleanup.jsonl').open('a') as f: f.write(json.dumps({'at': now(), 'reason': 'code3 finetuned resume closed out', 'files': removed}) + '\n')
    for item in removed: (ROOT / item['path']).unlink()
    update(state='resume_code3_complete', nextTask=None, currentArm=None, finishedAt=now())
    note('code3 finetuned resume complete; Windows data removed again.')
except Exception as error:
    update(state='resume_code3_failed', reason=str(error), finishedAt=now())
    note('code3 finetuned resume stopped on a concrete check: ' + str(error) + '. Records preserved; nothing else launched.')
    raise SystemExit(1)
