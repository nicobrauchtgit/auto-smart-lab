"""Private, disk-backed results backup; no source deletion or credential export."""
import collections
import sys
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import time
import urllib.parse
import zipfile
import ssl

os.umask(0o077)
ROOT = Path.cwd()
ARM = sys.argv[2] if len(sys.argv)>2 else 'minimal'
assert ARM in ('minimal','finetuned')
HERE = Path(__file__).resolve().parent / sys.argv[1] / ('backup' if ARM=='minimal' else 'backup-finetuned')
HERE.mkdir(parents=True,exist_ok=True)
CTX = ssl.create_default_context(cafile='/etc/ssl/certs/ca-bundle.crt')
EXCLUDE_DIRS = {'gpg', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.bun', '.cache', '.tmp'}
EXCLUDE_NAMES = {'auth.json', 'credentials.db', 'access_tokens.db', 'application_default_credentials.json', 'lab-cookies.txt'}
SECRETS = [v.encode() for k, v in os.environ.items()
           if k != 'SMARTLAB_ARCHIVE_PASSPHRASE' and any(s in k for s in ('API_KEY', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'SECRET', 'TOKEN', 'LAB_PASS', 'LANGFUSE_PUBLIC_KEY')) and len(v) >= 8]
STATUS = {'startedAt': datetime.now(timezone.utc).isoformat(), 'state': 'preparing',
          'originalsDeleted': False, 'archives': [], 'excluded': [], 'symlinks': [],
          'scope': 'Repository snapshot/history, minimal and finetuned results, historical archives, launches and prior exports. Credentials, environments, caches and linked external unit datasets are excluded.'}
if (HERE / 'status.json').exists():
    STATUS = json.loads((HERE / 'status.json').read_text())
    STATUS['excluded'] = []; STATUS['symlinks'] = []
    STATUS.pop('error', None)
STATUS.setdefault('credentialRedactions', [])

def save():
    path = HERE / 'status.json'
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(STATUS, indent=2) + '\n')
    temp.replace(path)

def safe_space():
    if shutil.disk_usage(ROOT).free < 2 * 1024**3:
        raise RuntimeError('Disk reserve below 2 GiB; stopped without deleting originals')

def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        while block := f.read(1024*1024): h.update(block)
    return h.hexdigest()

def credential_name(path):
    return path.name in EXCLUDE_NAMES or path.name == '.env' or path.name.startswith('.env.') or path.suffix in ('.cookies', '.pem', '.key')

def paths_under(base):
    for directory, dirs, files in os.walk(base, followlinks=False):
        for name in list(dirs):
            p = Path(directory) / name
            if p.is_symlink():
                STATUS['symlinks'].append({'path': str(p.relative_to(ROOT)), 'target': os.readlink(p)})
                dirs.remove(name)
            elif name in EXCLUDE_DIRS:
                STATUS['excluded'].append({'path': str(p.relative_to(ROOT)), 'reason': 'reinstallable environment/cache'})
                dirs.remove(name)
        for name in sorted(files):
            p = Path(directory) / name
            if p.is_symlink():
                STATUS['symlinks'].append({'path': str(p.relative_to(ROOT)), 'target': os.readlink(p)})
            elif p.name in {'docx-train-dev.zip', 'pdf-train-dev.zip', 'sealed.zip'}:
                STATUS['excluded'].append({'path': str(p.relative_to(ROOT)), 'reason': 'regeneratable malware dataset; original shared archives remain local'})
            elif credential_name(p):
                STATUS['excluded'].append({'path': str(p.relative_to(ROOT)), 'reason': 'credential file'})
            elif p.is_file(): yield p

TOKEN = ''
def refresh_token():
    global TOKEN
    r = subprocess.run(['./dev', 'gcloud', 'auth', 'print-access-token'], capture_output=True, text=True, timeout=30)
    if r.returncode: raise RuntimeError('Google login unavailable')
    TOKEN = r.stdout.strip()

def request(url, method='GET', data=None, headers=None, download=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in {'www.googleapis.com', 'content.googleapis.com'}:
        raise RuntimeError('Unexpected Google API endpoint')
    for attempt in range(2):
        connection = http.client.HTTPSConnection(parsed.hostname, context=CTX, timeout=60)
        all_headers = {'Authorization': 'Bearer ' + TOKEN, **(headers or {})}
        connection.request(method, parsed.path + ('?' + parsed.query if parsed.query else ''), body=data, headers=all_headers)
        response = connection.getresponse()
        status = response.status
        response_headers = dict(response.getheaders())
        if status == 401 and attempt == 0:
            response.read(); connection.close(); refresh_token(); continue
        if download and status == 200:
            with download.open('wb') as out:
                while block := response.read(1024*1024):
                    safe_space(); out.write(block)
            body = b''
        else: body = response.read()
        connection.close()
        if status not in (200, 201, 308):
            raise RuntimeError(f'Google Drive request failed (HTTP {status}); credential values omitted')
        return status, response_headers, body
    raise RuntimeError('Google authentication retry failed')

def api(path, method='GET', document=None):
    _, _, body = request('https://www.googleapis.com/drive/v3/' + path, method,
                         None if document is None else json.dumps(document).encode(),
                         {} if document is None else {'Content-Type': 'application/json'})
    return json.loads(body)

def upload_and_verify(path, inventory=None):
    safe_space()
    sha = digest_file(path)
    size = path.stat().st_size
    metadata = {'name': path.name, 'parents': [STATUS['folder']['id']],
                'appProperties': {'sha256': sha, 'purpose': 'auto-smart-lab-backup'}}
    _, headers, _ = request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,sha256Checksum,webViewLink',
                             'POST', json.dumps(metadata).encode(),
                             {'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/zip' if path.suffix == '.zip' else 'application/json',
                              'X-Upload-Content-Length': str(size)})
    session = next(v for k, v in headers.items() if k.lower() == 'location')
    offset = 0
    with path.open('rb') as source:
        while offset < size:
            safe_space(); source.seek(offset)
            chunk = source.read(8*1024*1024)
            status, headers, body = request(session, 'PUT', chunk,
                {'Content-Length': str(len(chunk)), 'Content-Range': f'bytes {offset}-{offset+len(chunk)-1}/{size}'})
            if status == 308:
                acknowledged = next((v for k, v in headers.items() if k.lower() == 'range'), '')
                next_offset = int(acknowledged.rsplit('-', 1)[1]) + 1 if acknowledged else 0
                if next_offset <= offset: raise RuntimeError('Upload made no forward progress')
                offset = next_offset
            else:
                file = json.loads(body); offset = size
            STATUS['uploadProgress'] = {'file': path.name, 'bytes': offset, 'total': size}
            save()
    return verify_remote(file, path, sha, size, inventory)

def verify_remote(file, path, sha, size, inventory=None):
    # Sharing is recorded, not enforced: the user shares the backup root on purpose
    # (2026-11-16, confirmed by the user). Only type/role are kept; no addresses enter the receipt.
    permissions = api('files/' + file['id'] + '/permissions?fields=permissions(type,role)')['permissions']
    sharing = sorted({(p['type'], p['role']) for p in permissions})
    restored = HERE / ('restore-' + path.name)
    # Drive refuses plain downloads of archives it flags as possibly abusive (malware samples in task data);
    # the owner may still download them with acknowledgeAbuse, which leaves the verification unchanged.
    request('https://www.googleapis.com/drive/v3/files/' + file['id'] + '?alt=media&acknowledgeAbuse=true', download=restored)
    if restored.stat().st_size != size or digest_file(restored) != sha:
        raise RuntimeError('Drive download SHA-256/size mismatch')
    if inventory is not None:
        with zipfile.ZipFile(restored) as bundle:
            if bundle.testzip() is not None: raise RuntimeError('Downloaded ZIP CRC failure')
            for item in inventory:
                h = hashlib.sha256()
                with bundle.open(item['path']) as stream:
                    while block := stream.read(1024*1024): h.update(block)
                if h.hexdigest() != item['sha256']: raise RuntimeError('Restored member hash mismatch')
    restored.unlink()  # Only the new verification duplicate, never source evidence.
    return {'name': path.name, 'bytes': size, 'sha256': sha, 'file': file,
            'roundTripVerified': True, 'inventoryFiles': None if inventory is None else len(inventory),
            'sharing': [{'type': t, 'role': r} for t, r in sharing]}

def pack(name, paths):
    inventory = []
    dest = HERE / name
    if dest.exists():
        dest.rename(HERE / (name + '.incomplete-' + str(time.time_ns())))
    with zipfile.ZipFile(dest, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as bundle:
        for path in paths:
            safe_space()
            rel = str(path.relative_to(ROOT))
            before = path.stat()
            original = None
            source_path = path
            if path.suffix.lower() in {'.json', '.jsonl', '.log', '.txt', '.md', '.py', '.ts', '.toml', '.yaml', '.yml', '.sh', '.cfg', '.ini'} and before.st_size <= 128*1024**2:
                data = path.read_bytes()
                if any(secret in data for secret in SECRETS):
                    data.decode('utf8')  # Do not corrupt binary evidence by redaction.
                    original = hashlib.sha256(data).hexdigest()
                    for secret in sorted(SECRETS, key=len, reverse=True):
                        data = data.replace(secret, b'[REDACTED_CREDENTIAL]')
                    safe = HERE / 'sanitized-inputs'
                    safe.mkdir(exist_ok=True)
                    source_path = safe / hashlib.sha256(rel.encode()).hexdigest()
                    source_path.write_bytes(data)
                    STATUS['credentialRedactions'].append({'path': rel, 'sourceSHA256': original, 'backupSHA256': hashlib.sha256(data).hexdigest(), 'originalChanged': False})
            digest = hashlib.sha256(); previous = b''
            with source_path.open('rb') as source, bundle.open(rel, 'w', force_zip64=True) as output:
                while block := source.read(1024*1024):
                    scan = previous + block
                    if any(secret in scan for secret in SECRETS):
                        raise RuntimeError('Credential detected in export input: ' + rel)
                    previous = scan[-max([len(v) for v in SECRETS] or [1]):]
                    digest.update(block); output.write(block)
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError('Backup input changed while reading: ' + rel)
            inventory.append({'path': rel, 'bytes': source_path.stat().st_size, 'sha256': digest.hexdigest(), 'mode': stat.S_IMODE(before.st_mode),
                              **({'credentialsRedacted': True, 'sourceSHA256': original} if original else {})})
        bundle.writestr('BACKUP-INVENTORY.json', json.dumps(inventory, indent=2) + '\n')
    (HERE / (name + '.inventory.json')).write_text(json.dumps(inventory, indent=2) + '\n')
    print(json.dumps({'packed': name, 'files': len(inventory), 'bytes': dest.stat().st_size}), flush=True)
    return dest, inventory

task=sys.argv[1]
assert task in ('documents1','documents2','documents3','documents4','code1','code2','code3','attacks1')
try:
    save(); refresh_token()
    STATUS['scope']=ARM+' continuation: source, memory, results and measurement records; dataset copies, credentials and environments excluded'
    if not STATUS.get('folder'): STATUS['folder']=api('files?fields=id,name,webViewLink','POST',{'name':'Qwen '+ARM+' continuation '+task+' '+datetime.now(timezone.utc).isoformat(),'mimeType':'application/vnd.google-apps.folder','parents':['1GO9xr3PSPhiyCe5mLJz-z7lQD5GGm_jq']});save()
    paths=[]
    if ARM=='minimal':
        run=ROOT/'runs/minimal/2026-11-11T08-29-56'
        for name in ('agent','logs','submissions','resources'):
            paths.extend(paths_under(run/name))
        paths.extend(p for p in run.iterdir() if p.is_file() and (p.suffix in ('.py','.json','.jsonl','.txt') or p.name=='requirements.txt'))
        for dirname in ('scratch',):
            if (run/dirname).is_dir(): paths.extend(p for p in paths_under(run/dirname) if p.suffix in ('.py','.json','.jsonl','.txt','.md'))
    else:
        for name in ('runs/finetuned/'+task,'runs/finetuned/solutions','runs/finetuned/deliveries/'+task,'runs/finetuned/findings'):
            if (ROOT/name).exists():paths.extend(paths_under(ROOT/name))
    launch=Path(__file__).resolve().parent
    for name in (task,'staging-'+{'documents1':'docx','documents2':'pdf','documents3':'rtf','documents4':'mix','code1':'android','code2':'php','code3':'win','attacks1':'adv'}[task]):
        if (launch/name).exists(): paths.extend(p for p in paths_under(launch/name) if not any(part.startswith('backup') for part in p.relative_to(launch/name).parts))
    paths.extend(ROOT/p for p in ('AGENTS.md','experiment.config.json','docs/experiments/qwen-unit2-continuation-2026-11-16.md'))
    paths=list(dict.fromkeys(paths))
    dest,inventory=pack(task+'-'+ARM+'-continuation.zip',paths)
    STATUS['state']='uploading-and-verifying';save()
    receipt=upload_and_verify(dest,inventory);STATUS['archives'].append(receipt)
    STATUS['state']='verified';STATUS['finishedAt']=datetime.now(timezone.utc).isoformat();save()
    manifest=HERE/'backup-manifest.json';manifest.write_text(json.dumps(STATUS,indent=2)+'\n')
    receipt=upload_and_verify(manifest);(HERE/'manifest-upload-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'state':'verified','folder':STATUS['folder']}),flush=True)
except Exception as error:
    STATUS['state']='failed';STATUS['error']=str(error);save();print('Backup failed; retained private receipts',flush=True);raise SystemExit(1)
