"""Observer-owned serial staging, supervised runs, verification and private backup."""
from pathlib import Path
import datetime,hashlib,json,os,subprocess,sys,zipfile,fcntl
ROOT=Path.cwd(); HERE=Path(__file__).resolve().parent
os.sched_setaffinity(0,{0,1,2,3})
for name in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ[name]='4'
LOCK=(HERE/'workflow.lock').open('a')
fcntl.flock(LOCK,fcntl.LOCK_EX|fcntl.LOCK_NB)
STATE=HERE/'status.json'; REPORT=ROOT/'docs/experiments/qwen-unit2-continuation-2026-11-16.md'
os.umask(0o077)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def update(**items):
    state=json.loads(STATE.read_text());state.update(items,updatedAt=now(),workflowPid=os.getpid())
    temp=STATE.with_suffix('.tmp');temp.write_text(json.dumps(state,indent=2)+'\n');temp.replace(STATE)
def note(text):
    with REPORT.open('a') as out:out.write('\n'+now()+' — '+text+'\n')
    print(text,flush=True)
def run(args,log):
    if (HERE/'WAIT_FOR_GO').exists():raise RuntimeError('Waiting for explicit user go')
    with (HERE/log).open('ab') as out:
        proc=subprocess.Popen(args,cwd=ROOT,stdout=out,stderr=subprocess.STDOUT)
        update(childPid=proc.pid,childCommand=args[:4],childLog=str(HERE/log))
        if proc.wait()!=0:raise RuntimeError('Step failed; inspect '+log)
def hashfile(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def active_runtime():
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name)==os.getpid():continue
        try:
            args=(p/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
            if any(name in args for name in ('agent/pipeline_cli.ts','agent/run/solve_units.ts')) and 'bash -c ' not in args:
                cwd=(p/'cwd').resolve()
                if cwd==ROOT or cwd.is_relative_to(ROOT):return True
        except (OSError,PermissionError):pass
    return False
def clean_shared(fmt):
    if active_runtime():raise RuntimeError('Runtime active; shared dataset cleanup postponed')
    folder=ROOT/f'units/02-maldoc/malicious-code-in-{"docx-documents" if fmt=="docx" else "pdf-files"}/data'
    receipts=[]
    for suffix in ('train.zip','test.zip','train.labels'):
        p=folder/(fmt+'-'+suffix)
        if p.exists():
            assert p.is_file() and not p.is_symlink()
            receipts.append({'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashfile(p)})
    # Persist provenance before removing only these reproducible data files.
    with (HERE/'dataset-cleanup.jsonl').open('a') as f:
        f.write(json.dumps({'at':now(),'reason':'Observer stages one task at a time; source and results retained','files':receipts})+'\n')
    for item in receipts:(ROOT/item['path']).unlink()
    note('Removed '+fmt.upper()+' shared dataset files; hashes and sizes retained in dataset-cleanup.jsonl.')
def material(task,fmt):
    folder=ROOT/f'units/02-maldoc/malicious-code-in-{"docx-documents" if fmt=="docx" else "pdf-files"}'
    assert (folder.parent/'unit-intro.md').stat().st_size>100,'Missing unit introduction'
    assert (folder/'prompt.md').stat().st_size>100,'Missing task description'
    meta=json.loads((folder/'meta.json').read_text())
    assert meta['short_id']==task and meta['unit_slug']=='02-maldoc' and meta['task_number']==int(task[-1]),'Wrong task material'
    return folder
if (HERE/'WAIT_FOR_GO').exists():raise SystemExit('Waiting for explicit user go')
try:
    update(state='preparing_documents1',startedAt=now())
    if active_runtime():raise RuntimeError('Another runtime active before staging; do not remove its data')
    if not json.loads(STATE.read_text())['completedTasks']:clean_shared('pdf')
    for task,fmt in (('documents1','docx'),('documents2','pdf')):
        if any(item['task']==task and item['arm']=='minimal' for item in json.loads(STATE.read_text())['completedTasks']):continue
        update(state='staging',nextTask=task)
        folder=material(task,fmt)
        if not all((folder/'data'/(fmt+'-'+suffix)).is_file() for suffix in ('train.zip','test.zip','train.labels')):
            run(['./dev','python',str(HERE/f'stage_{fmt}.py')],f'{task}-staging.log')
        old=ROOT/f'runs/diagnostics/unit2-{fmt}-setup-20261115/staging.json'
        expected=json.loads(old.read_text())
        for entry in expected:
            p=ROOT/entry['path'];assert p.stat().st_size==entry['zipBytes'] and hashfile(p)==entry['zipSha256'],'Dataset hash mismatch'
        train=folder/'data'/f'{fmt}-train.zip';labels=folder/'data'/f'{fmt}-train.labels'
        with zipfile.ZipFile(train) as z:
            matches=[i for i in z.infolist() if i.filename.endswith('.labels')]
            assert len(matches)==1,'Training labels member ambiguous'
            labels.write_bytes(z.read(matches[0]))
        if fmt=='docx':assert hashfile(labels)=='e1ef0f29b2b76c718eb1850a5e8ce4d07f638eb9a428b39d8cab573f17f87cea'
        note(task+': staged original dataset with matching saved SHA-256 and ZIP CRC, embedded training labels restored; unit/task material verified.')
        run(['./dev','bun','run','experiment','--','--arm','minimal','--continue','runs/minimal/2026-11-11T08-29-56','--only',task,'--check-setup'],f'{task}-preflight.log')
        update(state='running',nextTask=task)
        run(['./dev','bun',str(HERE/'controller.ts'),'minimal',task],f'{task}-controller.log')
        status=json.loads((HERE/task/'minimal/status.json').read_text());assert status['state']=='succeeded'
        row=status['tasks'][-1];output=Path(row['delivery']);manifest=json.loads((output.parent/'manifest.json').read_text())
        parts=[line.rsplit(';',1) for line in output.read_text().splitlines()];ids=[p[0] for p in parts]
        with zipfile.ZipFile(folder/'data'/f'{fmt}-test.zip') as z:expected_ids={i.filename for i in z.infolist() if not i.is_dir()}
        with zipfile.ZipFile(output.parent/'source.zip') as z:assert z.testzip() is None and z.infolist()
        assert len(ids)==len(set(ids))==manifest['lines'] and set(ids)==expected_ids
        assert all(len(p)==2 and p[1] in ('0','1') for p in parts)
        assert manifest['task']==task and hashfile(output)==manifest['sha256']
        receipt={'at':now(),'task':task,'verified':True,'rows':len(ids),'output':str(output),'outputSHA256':hashfile(output),'sourceSHA256':hashfile(output.parent/'source.zip')}
        (HERE/task/'verified-delivery.json').write_text(json.dumps(receipt,indent=2)+'\n')
        note(task+': minimal delivered '+str(len(ids))+' predictions; exact IDs, binary domain, manifest/hash and source ZIP integrity passed.')
        update(state='backing_up',nextTask=task)
        run(['./dev','python',str(HERE/'backup_task.py'),task],f'{task}-backup.log')
        backup=json.loads((HERE/task/'backup/status.json').read_text());assert backup['state']=='verified'
        state=json.loads(STATE.read_text());completed=state['completedTasks']+[{'task':task,'arm':'minimal','verifiedAt':now(),'driveFolder':backup['folder']}]
        update(completedTasks=completed,state='cleaning_dataset')
        note(task+': private Google Drive backup verified by download/hash/inventory; folder '+backup['folder'].get('webViewLink',backup['folder']['id']))
        clean_shared(fmt)
    # This controller owns the historical DOCX/PDF reruns. The observing
    # runner prepares and advances subsequent tasks from the course sources;
    # empty local directories are expected under rolling dataset availability.
    update(state='preparing_documents3',nextTask='documents3',reason='DOCX/PDF complete; observing runner must retrieve/verify RTF material and continue the authorized minimal/finetuned sequence')
    note('Minimal tasks 1 and 2 completed and backed up. Handing documents3 preparation and alternating-arm execution to the observing runner; missing local datasets alone are not a blocker.')
except Exception as error:
    update(state='failed',reason=str(error),finishedAt=now())
    note('Workflow stopped: '+str(error)+'. Evidence retained; no later task launched.')
    raise SystemExit(1)
