import tempfile, base64, gzip, hashlib, json, os, shutil, ssl, subprocess, time, urllib.request, zipfile
from pathlib import Path
from urllib.parse import urlsplit
ROOT = Path.cwd()
LOG = ROOT / "runs/launches/2026-11-16-qwen-unit2-continuation/staging-pdf"
LOG.mkdir(parents=True,exist_ok=True)
DEST = ROOT / "units/02-maldoc/malicious-code-in-pdf-files/data"
DEST.mkdir(parents=True, exist_ok=True)
GPG = "/nix/store/qa0fqi4mc640q2gj6y58wiq3i58xq8gq-gnupg-2.4.9/bin/gpg"
home = LOG / "gpg"
home.mkdir(mode=0o700, exist_ok=True)
share_secret = os.environ["SMARTLAB_SHARE_PASSWORD"]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise RuntimeError("redirect refused")
opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile="/etc/ssl/certs/ca-bundle.crt")))
files = json.loads((ROOT / "runs/diagnostics/unit2-share-inventory-20261114T232757Z.json").read_text())["files"]
receipts = []
def fetch(name):
    entry = next(x for x in files if x["name"] == name)
    href = entry["href"]
    assert href == "/public.php/webdav/02-maldoc/" + name
    out = LOG / (name + ".partial")
    if out.exists():
        old = json.loads((ROOT / "runs/diagnostics/unit2-pdf-setup-20261115/staging.json").read_text())
        known = next(x for x in old if x["source"] == href)
        sha=hashlib.file_digest(out.open("rb"),"sha256").hexdigest()
        assert out.stat().st_size == entry["bytes"] and sha == known["encryptedSha256"]
        print("Reusing verified encrypted download",flush=True)
        return out, {"source":href,"etag":entry["etag"],"encryptedBytes":out.stat().st_size,"encryptedSha256":sha}
    req = urllib.request.Request("https://cloud.mlsec.tu-berlin.de" + href, headers={"Authorization": "Basic " + base64.b64encode(("wD5GSTRbeS8reZH:" + share_secret).encode()).decode()})
    size=0; sha=hashlib.sha256(); started=time.monotonic(); reported=0
    with opener.open(req, timeout=90) as response, out.open("xb") as dst:
        assert response.status == 200
        assert int(response.headers["Content-Length"]) == entry["bytes"]
        assert response.headers.get("ETag") == entry["etag"], "remote file changed"
        while block := response.read(1024*1024):
            assert time.monotonic()-started < 1800, "download wall limit"
            assert shutil.disk_usage(ROOT).free > 2*1024**3, "disk reserve"
            dst.write(block); sha.update(block); size += len(block)
            if size-reported >= 64*1024**2:
                print(name, "downloaded MiB", size//1024**2, flush=True); reported=size
    assert size == entry["bytes"]
    return out, {"source":href, "etag":entry["etag"], "encryptedBytes":size, "encryptedSha256":sha.hexdigest()}
def decrypt(cipher, output):
    assert not output.exists()
    with tempfile.TemporaryFile(mode="w+b") as secret, (LOG / (output.name + ".gpg.log")).open("ab") as err:
        secret.write(os.environ["SMARTLAB_ARCHIVE_PASSPHRASE"].encode()); secret.seek(0)
        proc = subprocess.Popen([GPG,"--no-options","--homedir",str(home),"--batch","--no-tty","--no-autostart","--pinentry-mode","loopback","--passphrase-fd",str(secret.fileno()),"--decrypt",str(cipher)], pass_fds=(secret.fileno(),), stdout=subprocess.PIPE, stderr=err)
        size=0; sha=hashlib.sha256(); started=time.monotonic()
        try:
            with gzip.GzipFile(fileobj=proc.stdout) as src, output.open("xb") as dst:
                while block := src.read(1024*1024):
                    assert time.monotonic()-started < 900, "decode wall limit"
                    assert size + len(block) <= 2*1024**3, "decoded size bound"
                    assert shutil.disk_usage(ROOT).free > 2*1024**3, "disk reserve"
                    dst.write(block); sha.update(block); size += len(block)
            assert proc.wait(timeout=30) == 0, "GPG decryption failed; retained private log"
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            proc.stdout.close()
    return {"zipBytes":size,"zipSha256":sha.hexdigest()}
# PDF only; the same passphrase decrypted a 2 MiB prefix of the PDF archives (prefix_check.py).
for split in ("train", "test"):
    cipher, receipt = fetch("pdf-" + split + ".zip.gz.gpg")
    partial = DEST / ("pdf-" + split + ".zip.staged")
    receipt.update(decrypt(cipher, partial))
    with zipfile.ZipFile(partial) as z:
        infos=z.infolist()
        assert len(infos)<1000000
        assert sum(i.file_size for i in infos)<20*1024**3, "expanded ZIP size bound"
        assert all(not i.filename.startswith("/") and ".." not in Path(i.filename).parts for i in infos)
        assert len({i.filename for i in infos})==len(infos), "duplicate ZIP names"
        assert z.testzip() is None, "CRC failed"
        receipt.update({"members":len(infos), "files":sum(not i.is_dir() for i in infos), "expandedBytes":sum(i.file_size for i in infos), "maxMemberBytes":max(i.file_size for i in infos)})
    final=DEST / ("pdf-" + split + ".zip")
    assert not final.exists()
    partial.rename(final)
    receipt["path"]=str(final.relative_to(ROOT))
    cipher.unlink()
    receipts.append(receipt)
    (LOG / "staging.json").write_text(json.dumps(receipts,indent=2)+"\n")
    print(json.dumps(receipt),flush=True)
print("PDF staging complete; free GiB:",round(shutil.disk_usage(ROOT).free/1024**3,2),flush=True)
