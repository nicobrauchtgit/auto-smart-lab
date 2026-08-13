# SmartLab Auto Agent

A small, reproducible pipeline for SmartLab adversarial-AI exercises.

The pipeline is task-plugin based: each exercise gets one solver module under
`smartlab/tasks/`, while `smartlab_agent.py` provides the common CLI for
fetching data, validating locally, and producing submission files.

## Implemented tasks

- `spam1`: spam/ham email classification for unit `01-spam`, task 1.
  - Downloads `spam1-train.zip` and `spam1-test.zip`.
  - Trains a stdlib-only clipped-count Multinomial Naive Bayes text model over
    word tokens and character 3-grams.
  - Writes predictions as `path;label`, matching the SmartLab expected format.

## Quick start on the SmartLab VM

From this directory:

```bash
cd ~/auto_agent  # or /path/to/stud02/auto_agent
python3 smartlab_agent.py list
python3 smartlab_agent.py download spam1
python3 smartlab_agent.py validate spam1
python3 smartlab_agent.py solve spam1 --out submissions/spam1_predictions.csv
```

If the VM's Python virtual environment is active, the same commands work.  The
current `spam1` solver only uses Python's standard library, so it does not need
scikit-learn.

## Output

The spam task submission is written to:

```text
submissions/spam1_predictions.csv
```

Each line looks like:

```text
data/spam1-test/examplefilename.x;0
```

## Pipeline shape

For every new SmartLab task, add a new module in `smartlab/tasks/<task>.py` with
this minimal interface:

```python
def download(force: bool = False) -> None: ...
def validate(...) -> float: ...
def solve(output_path: Path) -> Path: ...
```

Then register it in `smartlab_agent.py`'s `TASKS` dictionary.

Recommended workflow per exercise:

1. Read the task page and identify train/test URLs and expected submission
   format.
2. Implement a task plugin that downloads data into `data/raw/`.
3. Build a baseline solver and a validation split using the official metric.
4. Generate a deterministic submission in `submissions/`.
5. Record validation score, command, and assumptions in `reports/`.

## Auth/session fetching for the lab website

`fetch_lab.py` automates the normal CSRF + login-cookie flow for the SmartLab
web UI. It is stdlib-only and writes a Netscape-format cookie jar that both
Python and `wget` can reuse.

Fetch only a fresh CSRF token/cookie from the login page:

```bash
python3 fetch_lab.py --insecure csrf
```

Create or refresh a logged-in session cookie file:

```bash
export LAB_USER='your_username'
export LAB_PASS='your_password'
export LAB_INSECURE_TLS=1   # needed for the lab's self-signed cert
./refresh_lab_session.sh
```

The default cookie jar is:

```text
lab-cookies.txt
```

Fetch a logged-in page with automatic re-login if the saved session expired:

```bash
python3 fetch_lab.py --insecure get \
  'https://lab-test.smartlab.mlsec.tu-berlin.de/units/8a84a7b83020423085b3595403848ffb/tasks/c32fae0bc0ea4c018b9aac9e0be4145c/' \
  -o downloaded_task_page/task.html
```

Do not paste real session tokens into chat. If manual token/cookie import is
ever needed, put it into `lab-cookies.txt` locally instead.

## Upload and score fetching

`smartlab_submit.py` is the one-stop abstraction the agent should call for
submissions. It uploads `output.csv` plus a source archive, then re-fetches the
task page and returns a compact score signal.

Check current attempts without uploading:

```bash
python3 smartlab_submit.py status \
  'https://lab-test.smartlab.mlsec.tu-berlin.de/units/f42497ac6e85482bb51b0a18b7578de7/tasks/10fb14fa58eb45c282f14e99c1134ffd/' \
  --insecure --json
```

Submit and directly receive score feedback:

```bash
python3 smartlab_submit.py upload \
  'TASK_URL' \
  path/to/output.csv \
  --source-dir . \
  --comment 'auto-agent attempt' \
  --insecure \
  --json
```

The JSON response is intentionally flat and compact:

```json
{
  "ok": true,
  "upload_ok": true,
  "upload_status": 200,
  "upload_message": "File successfully uploaded.",
  "error": null,
  "format_error": null,
  "max_tries": 3,
  "tries_used": 1,
  "tries_left": 2,
  "current_score": 0.991,
  "previous_scores": [0.987],
  "improved": true
}
```

If the server accepts the upload but rejects the CSV format, the script still
exits normally and returns `ok: false`, `upload_ok: true`, `current_score: null`,
and `format_error` with the message from the Attempts table. If the upload
itself fails, `upload_ok` is false and `error`/`upload_message` contain the
server message.

Important implementation detail: SmartLab's Dropzone uploader sends files as
multipart fields `file[0]` and `file[1]`, not repeated `file` fields. Repeated
plain `file` fields returned `File upload error.` during testing. The upload
endpoint itself only returns `File successfully uploaded.`; the score is only
available after fetching the rendered task page again.

## Existing helper

`fetch_task_page.sh` is a wget-based helper for mirroring the task page HTML and
page requisites. It uses `lab-cookies.txt` automatically when present, or you can
pass another Netscape-format cookie file:

```bash
LAB_INSECURE_TLS=1 COOKIE_FILE=/path/to/cookies.txt ./fetch_task_page.sh
```
