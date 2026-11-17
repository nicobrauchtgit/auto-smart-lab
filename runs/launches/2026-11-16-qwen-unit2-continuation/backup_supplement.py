"""Preserve DOCX working scripts, local measurement arrays and logs, excluding raw dataset caches."""
from pathlib import Path
import sys,datetime,json,os
os.sched_setaffinity(0,{0,1,2,3})
h=Path(__file__).resolve().parent
sys.argv=['supplement','documents1']
ns={'__file__':str(h/'backup_task.py')}
exec((h/'backup_task.py').read_text().split('\ntask=sys.argv[1]')[0],ns)
ns['HERE']=h/'documents1/backup-working-measurements';ns['HERE'].mkdir(exist_ok=True)
ns['STATUS']={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'state':'preparing','originalsDeleted':False,'archives':[],'excluded':[],'symlinks':[],'credentialRedactions':[],'scope':'DOCX working source and saved local measurements; raw train_raw/test_raw dataset pickle caches excluded'}
try:
 ns['refresh_token']()
 ns['STATUS']['folder']=json.loads((h/'documents1/backup/status.json').read_text())['folder']
 work=Path.cwd()/'runs/minimal/2026-11-11T08-29-56/work'
 paths=[p for p in ns['paths_under'](work) if p.suffix in ('.py','.log','.txt','.json','.jsonl','.npy')]
 dest,inventory=ns['pack']('documents1-working-measurements.zip',paths)
 receipt=ns['upload_and_verify'](dest,inventory)
 ns['STATUS']['archives'].append(receipt);ns['STATUS']['state']='verified';ns['STATUS']['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();ns['save']()
 manifest=ns['HERE']/'backup-manifest.json';manifest.write_text(json.dumps(ns['STATUS'],indent=2)+'\n');receipt=ns['upload_and_verify'](manifest);(ns['HERE']/'manifest-upload-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print('Supplemental working measurements backed up and round-trip verified',flush=True)
except Exception:
 ns['STATUS']['state']='failed';ns['save']();raise SystemExit('Supplemental backup failed; evidence retained, private error output omitted')
