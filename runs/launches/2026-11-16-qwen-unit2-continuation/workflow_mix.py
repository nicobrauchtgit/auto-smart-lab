"""Continue authorized mixed-bonus (documents4) arms serially; share current task data until both close out."""
from pathlib import Path
# Reuse established observer supervision/status helpers and its nonblocking workflow lock.
source=Path(__file__).with_name('workflow.py').read_text()
prefix,separator,_=source.partition("if (HERE/'WAIT_FOR_GO').exists():raise SystemExit")
assert separator, "Observer helper boundary missing; refuse to execute another workflow"
exec(prefix,globals())
def active_runtime():
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            args=(p/'cmdline').read_bytes().split(b'\0');cwd=(p/'cwd').resolve()
            if any(a==b'agent/run/solve_units.ts' or a.endswith(b'/agent/run/solve_units.ts') or a.endswith(b'/agent/pipeline_cli.ts') for a in args) and (cwd==ROOT or cwd.is_relative_to(ROOT)):return True
        except OSError:pass
    return False
try:
    checks=json.loads((HERE/'resource-mapping-validation.json').read_text())
    assert checks['passed'],'Resource integration checks must pass before models start'
    assert not active_runtime(),'An owned runtime is already active'
    task='documents4';folder=ROOT/'units/02-maldoc/mixed-malicious-code';data=folder/'data'
    inspect=json.loads((HERE/'staging-mix/data-inspection.json').read_text())
    for entry in inspect['files']:
        p=ROOT/'units/02-maldoc'/entry['file'];assert p.is_file() and hashfile(p)==entry['sha256']
    assert (folder.parent/'unit-intro.md').stat().st_size>100 and (folder/'prompt.md').stat().st_size>100
    assert json.loads((folder/'meta.json').read_text())['short_id']==task
    update(state='running_documents4',nextTask=task,startedAt=now())
    for arm in ('minimal','finetuned'):
        if any(x['task']==task and x['arm']==arm for x in json.loads(STATE.read_text())['completedTasks']):continue
        update(state='preflight',nextTask=task,currentArm=arm)
        args=['./dev','bun','run','experiment','--','--arm',arm]
        args+=['--continue','runs/minimal/2026-11-11T08-29-56','--only',task,'--check-setup'] if arm=='minimal' else ['--no-fetch','--check-setup',task]
        run(args,f'{task}-{arm}-preflight-current.log')
        update(state='running',currentArm=arm)
        run(['./dev','bun',str(HERE/'controller.ts'),arm,task],f'{task}-{arm}-controller.log')
        controller=json.loads((HERE/task/arm/'status.json').read_text());assert controller['state']=='succeeded'
        row=controller['tasks'][-1];assert row['validated'];output=Path(row['delivery']);manifest=json.loads((output.parent/'manifest.json').read_text())
        lines=[line.rsplit(';',1) for line in output.read_text().splitlines()];ids=[line[0] for line in lines]
        with zipfile.ZipFile(data/'mix-test.zip') as z:expected={x.filename for x in z.infolist() if not x.is_dir()}
        assert len(ids)==len(set(ids))==inspect['testRows']==manifest['lines'] and set(ids)==expected
        assert all(len(line)==2 and line[1] in ('0','1') for line in lines)
        assert hashfile(output)==manifest['sha256'] and manifest['task']==task
        with zipfile.ZipFile(output.parent/'source.zip') as z:assert z.testzip() is None and z.infolist()
        receipt={'at':now(),'task':task,'arm':arm,'verified':True,'rows':len(ids),'output':str(output),'outputSHA256':hashfile(output),'sourceSHA256':hashfile(output.parent/'source.zip')}
        (HERE/task/arm/'verified-delivery.json').write_text(json.dumps(receipt,indent=2)+'\n')
        note(task+' '+arm+': delivered '+str(len(ids))+' predictions; exact IDs, domain, hashes and source ZIP checks passed.')
        update(state='backing_up',currentArm=arm)
        run(['./dev','python',str(HERE/'backup_task.py'),task,arm],f'{task}-{arm}-backup.log')
        directory=HERE/task/('backup' if arm=='minimal' else 'backup-finetuned')
        backup=json.loads((directory/'status.json').read_text());assert backup['state']=='verified' and (directory/'manifest-upload-receipt.json').is_file()
        state=json.loads(STATE.read_text());completed=state['completedTasks']+[{'task':task,'arm':arm,'verifiedAt':now(),'driveFolder':backup['folder']}]
        update(completedTasks=completed)
        note(task+' '+arm+': private Drive round-trip verified; '+backup['folder'].get('webViewLink',backup['folder']['id']))
    assert not active_runtime(),'Cleanup postponed for an owned runtime'
    files=[]
    for entry in inspect['files']:
        p=ROOT/'units/02-maldoc'/entry['file'];files.append({'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashfile(p)})
    with (HERE/'dataset-cleanup.jsonl').open('a') as f:f.write(json.dumps({'at':now(),'reason':'Both documents4 arms verified and backed up; raw shared task inputs no longer needed','files':files})+'\n')
    for item in files:(ROOT/item['path']).unlink()
    update(state='needs_next_task_preparation',nextTask='code1',currentArm=None,finishedAt=now(),reason='documents4 arms complete; observer should retrieve and prepare the next dataset-backed task (code1) from established sources before declaring a blocker')
    note('documents4 both arms complete and backed up. Shared mixed-task data removed. Next: prepare code1 from original course sources. Tor remains deferred to user-provided task information.')
except Exception as error:
    update(state='failed',reason=str(error),finishedAt=now())
    note('documents4 workflow stopped on a concrete check: '+str(error)+'. Inspect preserved receipts. No later arm/task launched.')
    raise SystemExit(1)
