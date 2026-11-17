"""Stage one code/attacks task from the course share: download, verify size and
ETag, decrypt (GPG + gzip) when needed, check ZIP CRC, restore an embedded
training-labels member as <fmt>-train.labels. Static reads only; nothing is
extracted or executed. Usage: ./dev python stage_code.py php|android|win|adv
Credentials come from the observer environment (.env), never from this file.
"""
import base64, collections, datetime, gzip, hashlib, json, os, shutil, ssl, subprocess, sys, tempfile, time, urllib.request, zipfile
from pathlib import Path

FMT = sys.argv[1]
TASKS = {"android": ("code1", "clustering-of-malicious-code/malicious-code-for-android", "03-clust"),
         "php": ("code2", "clustering-of-malicious-code/malicious-code-for-web-servers", "03-clust"),
         "win": ("code3", "clustering-of-malicious-code/malicious-code-for-windows", "03-clust"),
         "adv": ("attacks1", "detection-of-unknown-attacks/adversarial-example-detection", "05-anomaly")}
TASK, UNIT_DIR, SHARE_DIR = TASKS[FMT]
ROOT = Path.cwd()
LOG = ROOT / f"runs/launches/2026-11-16-qwen-unit2-continuation/staging-{FMT}"
DEST = ROOT / "units" / UNIT_DIR / "data"
GPG = "/nix/store/qa0fqi4mc640q2gj6y58wiq3i58xq8gq-gnupg-2.4.9/bin/gpg"
for d in (LOG, DEST): d.mkdir(parents=True, exist_ok=True)
home = LOG / "gpg"; home.mkdir(mode=0o700, exist_ok=True)
os.sched_setaffinity(0, {0, 1, 2, 3})
for line in (ROOT / ".env").read_text().splitlines():  # only the two staging keys; values never printed
    key, _, value = line.partition("=")
    if key.strip() in ("SMARTLAB_SHARE_PASSWORD", "SMARTLAB_ARCHIVE_PASSPHRASE") and key.strip() not in os.environ:
        value = value.strip()
        os.environ[key.strip()] = value[1:-1] if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"" else value
INVENTORY = json.loads((ROOT / "runs/diagnostics/course-share-inventory-20261116.json").read_text())["files"]
opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile="/etc/ssl/certs/ca-bundle.crt")))
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def hashfile(p):
    with p.open("rb") as f: return hashlib.file_digest(f, "sha256").hexdigest()

def fetch(name):
    href = f"/public.php/webdav/{SHARE_DIR}/{name}"
    entry = next(x for x in INVENTORY if x["href"] == href)
    out = LOG / (name + ".partial")
    if out.exists(): out.unlink()
    auth = base64.b64encode(("wD5GSTRbeS8reZH:" + os.environ["SMARTLAB_SHARE_PASSWORD"]).encode()).decode()
    req = urllib.request.Request("https://cloud.mlsec.tu-berlin.de" + href, headers={"Authorization": "Basic " + auth})
    sha = hashlib.sha256(); size = 0; started = time.monotonic()
    with opener.open(req, timeout=90) as response, out.open("xb") as dst:
        assert response.status == 200 and response.headers.get("ETag") == entry["etag"], "remote file changed"
        while block := response.read(1024 * 1024):
            assert time.monotonic() - started < 3600, "download wall limit"
            assert shutil.disk_usage(ROOT).free > 6 * 1024**3, "disk reserve"
            dst.write(block); sha.update(block); size += len(block)
    assert size == entry["bytes"]
    return out, {"source": href, "etag": entry["etag"], "downloadBytes": size, "downloadSha256": sha.hexdigest()}

def decrypt(cipher, output):
    with tempfile.TemporaryFile(mode="w+b") as secret, (LOG / (output.name + ".gpg.log")).open("ab") as err:
        secret.write(os.environ["SMARTLAB_ARCHIVE_PASSPHRASE"].encode()); secret.seek(0)
        proc = subprocess.Popen([GPG, "--no-options", "--homedir", str(home), "--batch", "--no-tty", "--no-autostart", "--pinentry-mode", "loopback",
                                 "--passphrase-fd", str(secret.fileno()), "--decrypt", str(cipher)], pass_fds=(secret.fileno(),), stdout=subprocess.PIPE, stderr=err)
        try:
            with gzip.GzipFile(fileobj=proc.stdout) as src, output.open("xb") as dst:
                while block := src.read(1024 * 1024):
                    assert shutil.disk_usage(ROOT).free > 6 * 1024**3, "disk reserve"
                    dst.write(block)
            assert proc.wait(timeout=60) == 0, "GPG decryption failed"
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            proc.stdout.close()

receipt = {"task": TASK, "startedAt": now(), "files": []}
try:
    for split in ("train", "test"):
        final = DEST / f"{FMT}-{split}.zip"
        staged = DEST / f"{FMT}-{split}.zip.staged"
        if staged.exists(): staged.unlink()
        encrypted = FMT != "adv"
        download, r = fetch(f"{FMT}-{split}.zip" + (".gz.gpg" if encrypted else ""))
        if encrypted: decrypt(download, staged); download.unlink()
        else: download.rename(staged)
        with zipfile.ZipFile(staged) as z:
            infos = z.infolist()
            assert all(not i.filename.startswith("/") and ".." not in Path(i.filename).parts for i in infos), "unsafe member path"
            assert len({i.filename for i in infos}) == len(infos), "duplicate member names"
            assert z.testzip() is None, "CRC failed"
            files = [i for i in infos if not i.is_dir()]
            labels = [i for i in files if i.filename.endswith(".labels")]
            r.update({"split": split, "members": len(files), "expandedBytes": sum(i.file_size for i in files),
                      "labelMembers": [i.filename for i in labels],
                      "suffixes": dict(collections.Counter(Path(i.filename).suffix for i in files).most_common(8)),
                      "topLevelDirs": sorted({i.filename.split("/")[0] for i in files if "/" in i.filename})[:8]})
            if split == "train" and len(labels) == 1:
                text = z.read(labels[0]).decode("utf-8")
                rows = [line.rsplit(";", 1) for line in text.splitlines() if line.strip()]
                samples = {i.filename for i in files} - {labels[0].filename}
                assert {row[0] for row in rows} == samples and len(rows) == len(samples), "label coverage not exact"
                (DEST / f"{FMT}-train.labels").write_text(text if text.endswith("\n") else text + "\n")
                r["targets"] = dict(collections.Counter(row[1] for row in rows).most_common())
            assert split == "train" or not labels, "unexpected labels in test archive"
        if FMT == "adv" and split == "train":
            # The share archive also holds a byte-identical labelled copy (.0-.3) of every .x image;
            # the task gives no labels, so agents get only the .x members.
            r["originalSha256"] = hashfile(staged)
            slim = staged.with_suffix(".slim")
            with zipfile.ZipFile(staged) as s, zipfile.ZipFile(slim, "x") as o:
                for i in s.infolist():
                    if i.filename.endswith(".x"): o.writestr(i, s.read(i))
            with zipfile.ZipFile(slim) as z: assert z.testzip() is None
            os.replace(slim, staged); r["removedLabelledCopies"] = r["members"] // 2
        staged.rename(final)
        r.update({"path": str(final.relative_to(ROOT)), "bytes": final.stat().st_size, "sha256": hashfile(final)})
        receipt["files"].append(r); print(json.dumps(r), flush=True)
    receipt["finishedAt"] = now()
except Exception as error:
    receipt["error"] = str(error); receipt["failedAt"] = now()
    print("staging failed:", error, flush=True)
(LOG / "staging.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(TASK, "staging", "failed" if "error" in receipt else "complete", "; free GiB", round(shutil.disk_usage(ROOT).free / 1024**3, 2), flush=True)
sys.exit(1 if "error" in receipt else 0)
