"""Run code/attacks tasks serially: stage one task, minimal then finetuned, verify, back up, clean up.
Stops before agents start if a task description still has a PENDING local protocol."""
from pathlib import Path
source = Path(__file__).with_name('workflow.py').read_text()
prefix, separator, _ = source.partition("if (HERE/'WAIT_FOR_GO').exists():raise SystemExit")
assert separator, "Observer helper boundary missing"
exec(prefix, globals())
TASKS = [('code2', 'php', 'clustering-of-malicious-code/malicious-code-for-web-servers'),
         ('attacks1', 'adv', 'detection-of-unknown-attacks/adversarial-example-detection'),
         ('code3', 'win', 'clustering-of-malicious-code/malicious-code-for-windows'),
         ('code1', 'android', 'clustering-of-malicious-code/malicious-code-for-android')]
try:
    assert not active_runtime(), 'An owned runtime is already active'
    update(state='running_code_attacks', startedAt=now())
    for task, fmt, unit in TASKS:
        done = {x['arm'] for x in json.loads(STATE.read_text())['completedTasks'] if x['task'] == task}
        folder = ROOT / 'units' / unit; data = folder / 'data'
        if done == {'minimal', 'finetuned'} and not any(p.is_file() for p in data.glob('*')): continue
        files = [data / f'{fmt}-train.zip', data / f'{fmt}-test.zip']
        if not all(p.is_file() for p in files):
            update(state='staging', nextTask=task, currentArm=None)
            run(['./dev', 'python', str(HERE / 'stage_code.py'), fmt], f'{fmt}-staging.log')
        assert (folder.parent / 'unit-intro.md').stat().st_size > 100, 'Missing unit introduction'
        prompt = (folder / 'prompt.md').read_text()
        assert len(prompt) > 100 and json.loads((folder / 'meta.json').read_text())['short_id'] == task, 'Wrong task material'
        if 'PENDING:' in prompt:
            update(state='needs_task_protocol', nextTask=task, currentArm=None,
                   reason=f'{task} data staged; observer must write the local protocol facts in prompt.md before agents start')
            note(f'{task}: data staged; waiting for the observer to replace the PENDING local protocol in prompt.md. No agent started.')
            raise SystemExit(0)
        with zipfile.ZipFile(files[1]) as z: expected = {i.filename for i in z.infolist() if not i.is_dir()}
        for arm in ('minimal', 'finetuned'):
            if arm in done: continue
            update(state='preflight', nextTask=task, currentArm=arm)
            args = ['./dev', 'bun', 'run', 'experiment', '--', '--arm', arm]
            args += ['--continue', 'runs/minimal/2026-11-11T08-29-56', '--only', task, '--check-setup'] if arm == 'minimal' else ['--no-fetch', '--check-setup', task]
            run(args, f'{task}-{arm}-preflight.log')
            update(state='running', currentArm=arm)
            run(['./dev', 'bun', str(HERE / 'controller.ts'), arm, task], f'{task}-{arm}-controller.log')
            controller = json.loads((HERE / task / arm / 'status.json').read_text()); assert controller['state'] == 'succeeded'
            row = controller['tasks'][-1]; assert row['validated']; output = Path(row['delivery'])
            manifest = json.loads((output.parent / 'manifest.json').read_text())
            lines = [line.rsplit(';', 1) for line in output.read_text().splitlines()]; ids = [line[0] for line in lines]
            assert len(ids) == len(set(ids)) == len(expected) == manifest['lines'] and set(ids) == expected, 'Delivery IDs differ from the test archive'
            domain = (lambda v: v.lstrip('-').isdigit()) if task.startswith('code') else (lambda v: v in ('0', '1'))
            assert all(len(line) == 2 and domain(line[1]) for line in lines), 'Prediction domain'
            assert hashfile(output) == manifest['sha256'] and manifest['task'] == task
            with zipfile.ZipFile(output.parent / 'source.zip') as z: assert z.testzip() is None and z.infolist()
            receipt = {'at': now(), 'task': task, 'arm': arm, 'verified': True, 'rows': len(ids), 'output': str(output),
                       'outputSHA256': hashfile(output), 'sourceSHA256': hashfile(output.parent / 'source.zip')}
            (HERE / task / arm / 'verified-delivery.json').write_text(json.dumps(receipt, indent=2) + '\n')
            note(f'{task} {arm}: delivered {len(ids)} predictions; exact IDs, domain, hashes and source ZIP checks passed.')
            update(state='backing_up', currentArm=arm)
            run(['./dev', 'python', str(HERE / 'backup_task.py'), task, arm], f'{task}-{arm}-backup.log')
            directory = HERE / task / ('backup' if arm == 'minimal' else 'backup-finetuned')
            backup = json.loads((directory / 'status.json').read_text())
            assert backup['state'] == 'verified' and (directory / 'manifest-upload-receipt.json').is_file()
            state = json.loads(STATE.read_text())
            update(completedTasks=state['completedTasks'] + [{'task': task, 'arm': arm, 'verifiedAt': now(), 'driveFolder': backup['folder']}])
            note(f'{task} {arm}: private Drive round-trip verified; ' + backup['folder'].get('webViewLink', backup['folder']['id']))
        assert not active_runtime(), 'Cleanup postponed for an owned runtime'
        removed = [{'path': str(p.relative_to(ROOT)), 'bytes': p.stat().st_size, 'sha256': hashfile(p)} for p in sorted(data.iterdir()) if p.is_file()]
        with (HERE / 'dataset-cleanup.jsonl').open('a') as f:
            f.write(json.dumps({'at': now(), 'reason': f'Both {task} arms verified and backed up', 'files': removed}) + '\n')
        for item in removed: (ROOT / item['path']).unlink()
        note(f'{task}: both arms complete and backed up; task data removed (hashes in dataset-cleanup.jsonl).')
    update(state='code_attacks_complete', nextTask=None, currentArm=None, finishedAt=now())
    note('code2, attacks1, code3 and code1 complete for both arms. Tor remains deferred.')
except SystemExit:
    raise
except Exception as error:
    update(state='failed', reason=str(error), finishedAt=now())
    note('code/attacks workflow stopped on a concrete check: ' + str(error) + '. Inspect preserved receipts. No later arm/task launched.')
    raise SystemExit(1)
