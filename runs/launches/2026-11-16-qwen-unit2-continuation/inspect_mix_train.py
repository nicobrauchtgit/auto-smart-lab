# Decrypt and statically inspect the 346-byte mixed training ciphertext already
# downloaded on 2026-11-15. Nothing is extracted; listing only. Secrets via env.
import gzip, hashlib, io, json, os, subprocess, tempfile, zipfile, datetime
from pathlib import Path
ROOT=Path.cwd(); LOG=ROOT/"runs/launches/2026-11-16-qwen-unit2-continuation/staging-mix"
GPG="/nix/store/qa0fqi4mc640q2gj6y58wiq3i58xq8gq-gnupg-2.4.9/bin/gpg"
home=LOG/"gpg"; home.mkdir(mode=0o700,exist_ok=True)
cipher=ROOT/"runs/diagnostics/unit2-docx-setup-20261115/mix-train.zip.gz.gpg.partial"
data=cipher.read_bytes(); assert len(data)==346
r={"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source":"/public.php/webdav/02-maldoc/mix-train.zip.gz.gpg","localCopy":str(cipher.relative_to(ROOT)),"encryptedBytes":len(data),"encryptedSha256":hashlib.sha256(data).hexdigest()}
with tempfile.TemporaryFile(mode="w+b") as secret, (LOG/"mix-train.gpg.log").open("ab") as err:
    secret.write(os.environ["SMARTLAB_ARCHIVE_PASSPHRASE"].encode()); secret.seek(0)
    p=subprocess.run([GPG,"--no-options","--homedir",str(home),"--batch","--no-tty","--no-autostart","--pinentry-mode","loopback","--passphrase-fd",str(secret.fileno()),"--decrypt",str(cipher)],pass_fds=(secret.fileno(),),stdout=subprocess.PIPE,stderr=err,timeout=60)
r["gpgExit"]=p.returncode
if p.returncode==0:
    gz=p.stdout; r["gzipBytes"]=len(gz); raw=gzip.decompress(gz); r["zipBytes"]=len(raw); r["zipSha256"]=hashlib.sha256(raw).hexdigest()
    try:
        z=zipfile.ZipFile(io.BytesIO(raw)); infos=z.infolist()
        r["members"]=[{"name":i.filename,"bytes":i.file_size,"dir":i.is_dir()} for i in infos]; r["testzip"]=z.testzip()
    except zipfile.BadZipFile as e:
        r["zipError"]=str(e); r["rawPrefixHex"]=raw[:64].hex()
(LOG/"mix-train-inspection.json").write_text(json.dumps(r,indent=2)+"\n"); print(json.dumps(r,indent=1))
if p.returncode==0 and "members" in r:
    note=z.read("mix-train.txt"); (LOG/"mix-train.txt").write_bytes(note)
    print("NOTE sha256",hashlib.sha256(note).hexdigest()); print(repr(note.decode("utf-8","replace")))
