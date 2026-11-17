"""Stage documents4 (mixed bonus) from the course share; static reads only.

Course note inside mix-train.zip (verbatim, staging-mix/mix-train.txt): there is
no own training data; all training data of the other tasks may be used. The
training input is therefore the union of the original DOCX, PDF and RTF training
archives, verified against their earlier staging hashes and repackaged
(ZIP_STORED, like the originals) under `docx-train/`, `pdf-train/`, `rtf-train/`
prefixes that keep each original member ID and its source archive. The test
input is the original mix-test.zip. Nothing is extracted or executed.
"""
import base64, collections, datetime, gzip, hashlib, json, os, shutil, ssl, subprocess, tempfile, time, urllib.request, zipfile
from pathlib import Path

ROOT = Path.cwd()
LOG = ROOT / "runs/launches/2026-11-16-qwen-unit2-continuation/staging-mix"
TMP = LOG / "tmp"
DEST = ROOT / "units/02-maldoc/mixed-malicious-code/data"
GPG = "/nix/store/qa0fqi4mc640q2gj6y58wiq3i58xq8gq-gnupg-2.4.9/bin/gpg"
for d in (LOG, TMP, DEST): d.mkdir(parents=True, exist_ok=True)
home = LOG / "gpg"; home.mkdir(mode=0o700, exist_ok=True)
os.sched_setaffinity(0, {0, 1, 2, 3})
INVENTORY = json.loads((ROOT / "runs/diagnostics/unit2-share-inventory-20261114T232757Z.json").read_text())["files"]
# Exact decrypted ZIPs used by documents1-3 (their staging receipts).
EXPECTED = {
    "docx": ("runs/diagnostics/unit2-docx-setup-20261115/staging.json", "docx-train.zip.gz.gpg"),
    "pdf": ("runs/diagnostics/unit2-pdf-setup-20261115/staging.json", "pdf-train.zip.gz.gpg"),
    "rtf": ("runs/launches/2026-11-16-qwen-unit2-continuation/staging-rtf/staging.json", "rtf-train.zip.gz.gpg"),
}
opener_ctx = ssl.create_default_context(cafile="/etc/ssl/certs/ca-bundle.crt")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise RuntimeError("redirect refused")
opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=opener_ctx))
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def hashfile(p):
    with p.open("rb") as f: return hashlib.file_digest(f, "sha256").hexdigest()
receipts = {"startedAt": now(), "inputs": []}
def save(): (LOG / "staging.json").write_text(json.dumps(receipts, indent=2) + "\n")

def fetch(name):
    entry = next(x for x in INVENTORY if x["name"] == name)
    href = entry["href"]; assert href == "/public.php/webdav/02-maldoc/" + name
    out = TMP / (name + ".partial")
    if out.exists(): out.unlink()
    secret = os.environ["SMARTLAB_SHARE_PASSWORD"]
    req = urllib.request.Request("https://cloud.mlsec.tu-berlin.de" + href, headers={"Authorization": "Basic " + base64.b64encode(("wD5GSTRbeS8reZH:" + secret).encode()).decode()})
    size = 0; sha = hashlib.sha256(); started = time.monotonic(); reported = 0
    with opener.open(req, timeout=90) as response, out.open("xb") as dst:
        assert response.status == 200
        assert int(response.headers["Content-Length"]) == entry["bytes"]
        assert response.headers.get("ETag") == entry["etag"], "remote file changed"
        while block := response.read(1024 * 1024):
            assert time.monotonic() - started < 2400, "download wall limit"
            assert shutil.disk_usage(ROOT).free > 6 * 1024**3, "disk reserve"
            dst.write(block); sha.update(block); size += len(block)
            if size - reported >= 128 * 1024**2: print(name, "MiB", size // 1024**2, flush=True); reported = size
    assert size == entry["bytes"]
    return out, {"source": href, "etag": entry["etag"], "encryptedBytes": size, "encryptedSha256": sha.hexdigest()}

def decrypt(cipher, output):
    assert not output.exists()
    with tempfile.TemporaryFile(mode="w+b") as secret, (LOG / (output.name + ".gpg.log")).open("ab") as err:
        secret.write(os.environ["SMARTLAB_ARCHIVE_PASSPHRASE"].encode()); secret.seek(0)
        proc = subprocess.Popen([GPG, "--no-options", "--homedir", str(home), "--batch", "--no-tty", "--no-autostart", "--pinentry-mode", "loopback", "--passphrase-fd", str(secret.fileno()), "--decrypt", str(cipher)], pass_fds=(secret.fileno(),), stdout=subprocess.PIPE, stderr=err)
        size = 0; sha = hashlib.sha256(); started = time.monotonic()
        try:
            with gzip.GzipFile(fileobj=proc.stdout) as src, output.open("xb") as dst:
                while block := src.read(1024 * 1024):
                    assert time.monotonic() - started < 1200, "decode wall limit"
                    assert size + len(block) <= 4 * 1024**3, "decoded size bound"
                    assert shutil.disk_usage(ROOT).free > 6 * 1024**3, "disk reserve"
                    dst.write(block); sha.update(block); size += len(block)
            assert proc.wait(timeout=30) == 0, "GPG decryption failed; retained private log"
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            proc.stdout.close()
    return {"zipBytes": size, "zipSha256": sha.hexdigest()}

def safe_infos(z):
    infos = z.infolist()
    assert len(infos) < 1_000_000 and sum(i.file_size for i in infos) < 20 * 1024**3
    assert all(not i.filename.startswith("/") and ".." not in Path(i.filename).parts for i in infos)
    assert len({i.filename for i in infos}) == len(infos), "duplicate ZIP names"
    assert z.testzip() is None, "CRC failed"
    return infos

def parse_labels(text):
    rows = {}
    for line in text.splitlines():
        if not line.strip(): continue
        member, target = line.rsplit(";", 1)
        assert target in ("0", "1") and member not in rows
        rows[member] = target
    return rows

try:
    # 1. Training archives: identical to the documents1-3 inputs.
    train = {}
    for fmt, (receipt_path, name) in EXPECTED.items():
        expected = next(x for x in json.loads((ROOT / receipt_path).read_text()) if x["source"].endswith("/" + name))
        cipher, r = fetch(name)
        z_path = TMP / f"{fmt}-train.zip"
        if z_path.exists(): z_path.unlink()
        r.update(decrypt(cipher, z_path)); cipher.unlink()
        assert r["zipSha256"] == expected["zipSha256"] and r["zipBytes"] == expected["zipBytes"], f"{fmt} training archive differs from its documents task staging"
        r.update({"format": fmt, "matchesEarlierStaging": receipt_path}); receipts["inputs"].append(r); save()
        train[fmt] = z_path; print(json.dumps(r), flush=True)
    # 2. Original mixed test archive.
    cipher, r = fetch("mix-test.zip.gz.gpg")
    staged = DEST / "mix-test.zip.staged"
    if staged.exists(): staged.unlink()
    r.update(decrypt(cipher, staged)); cipher.unlink()
    with zipfile.ZipFile(staged) as z:
        test_infos = safe_infos(z)
        test_ids = [i.filename for i in test_infos if not i.is_dir()]
        assert not any(i.filename.endswith(".labels") for i in test_infos), "unexpected labels in test archive"
        r.update({"members": len(test_infos), "files": len(test_ids), "expandedBytes": sum(i.file_size for i in test_infos),
                  "suffixes": dict(collections.Counter(Path(x).suffix for x in test_ids).most_common(8)),
                  "topLevelDirs": sorted({x.split("/")[0] for x in test_ids if "/" in x})[:8]})
    staged.rename(DEST / "mix-test.zip"); r["path"] = str((DEST / "mix-test.zip").relative_to(ROOT)); r["format"] = "mix-test"
    receipts["inputs"].append(r); save(); print(json.dumps(r), flush=True)
    # 3. Union training archive and labels, original member IDs under a source prefix.
    out_zip = DEST / "mix-train.zip.staged"; out_labels = DEST / "mix-train.labels.staged"
    for p in (out_zip, out_labels):
        if p.exists(): p.unlink()
    label_lines = []; per_format = {}; train_ids = set()
    with zipfile.ZipFile(out_zip, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as dst:
        for fmt, path in train.items():
            with zipfile.ZipFile(path) as src:
                infos = safe_infos(src)
                label_members = [i for i in infos if i.filename.endswith(".labels")]
                assert len(label_members) == 1, "training labels member ambiguous"
                labels = parse_labels(src.read(label_members[0]).decode("utf-8"))
                samples = [i for i in infos if not i.is_dir() and i is not label_members[0]]
                assert set(labels) == {i.filename for i in samples}, f"{fmt} label coverage not exact"
                for member, target in labels.items():
                    if member.endswith((".0", ".1")): assert member[-1] == target, f"{fmt} suffix/label disagreement"
                for info in samples:
                    new = f"{fmt}-train/{info.filename}"
                    with src.open(info) as fin, dst.open(zipfile.ZipInfo(new, date_time=info.date_time), "w", force_zip64=info.file_size > 2**31) as fout:
                        shutil.copyfileobj(fin, fout, 1024 * 1024)
                    label_lines.append(f"{new};{labels[info.filename]}"); train_ids.add(new)
                per_format[fmt] = {"samples": len(samples), "classCounts": dict(collections.Counter(labels.values())), "labelsMemberSha256": hashlib.sha256(src.read(label_members[0])).hexdigest()}
                print(fmt, "packed", len(samples), flush=True)
    out_labels.write_text("\n".join(label_lines) + "\n")
    with zipfile.ZipFile(out_zip) as z: assert z.testzip() is None and len(z.infolist()) == len(label_lines)
    out_zip.rename(DEST / "mix-train.zip"); out_labels.rename(DEST / "mix-train.labels")
    for path in train.values(): path.unlink()
    # 4. Inspection receipt in the documents3 format consumed by the workflow.
    files = []
    for name in ("mix-test.zip", "mix-train.labels", "mix-train.zip"):
        p = DEST / name; files.append({"file": str(p.relative_to(ROOT / "units/02-maldoc")), "bytes": p.stat().st_size, "sha256": hashfile(p)})
    h = hashlib.sha256()
    for f in sorted(files, key=lambda x: x["file"]): h.update(f["file"].encode()); h.update(b"\0"); h.update(f["sha256"].encode()); h.update(b"\0")
    test_names = set(test_ids)
    inspection = {"at": now(), "task": "documents4", "trainingRows": len(label_lines), "testRows": len(test_ids),
                  "classCounts": dict(collections.Counter(l.rsplit(";", 1)[1] for l in label_lines)), "perFormat": per_format,
                  "labelCoverageExact": True, "trainTestDisjoint": not (train_ids & test_names) and not ({i.split("/", 1)[1] for i in train_ids} & test_names),
                  "trainingProtocol": "Union of the original DOCX, PDF and RTF training archives (course note mix-train.txt); IDs prefixed with their source archive stem",
                  "files": files, "dataHash": h.hexdigest(), "dataHashScope": "mixed-malicious-code data files only, fetch_unit algorithm"}
    (LOG / "data-inspection.json").write_text(json.dumps(inspection, indent=2) + "\n")
    receipts["finishedAt"] = now(); save()
    print(json.dumps({k: inspection[k] for k in ("trainingRows", "testRows", "classCounts", "trainTestDisjoint", "dataHash")}), flush=True)
    print("documents4 staging complete; free GiB:", round(shutil.disk_usage(ROOT).free / 1024**3, 2), flush=True)
except Exception as error:
    receipts["error"] = str(error); receipts["failedAt"] = now(); save()
    print("staging failed:", error, flush=True); raise SystemExit(1)
