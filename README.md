# SmartLab Auto Agent

A small, reproducible setup for SmartLab adversarial-AI exercises.

The repo has **two sections**:

- `agent/` — the **agent runtime**: the pipeline that solves challenges, the pi
  tools, and the pi setup.
  - `agent/smartlab_agent.py` + `agent/smartlab/` — task-plugin pipeline (one
    solver module per exercise under `agent/smartlab/tasks/`).
  - `agent/tools/smartlab.ts` — the pi submission tool (wired via `.pi/settings.json`).
  - `agent/setup/` — **isolated** challenge-setup infra (login, data fetch,
    inventory, upload). Not accessible to the pipeline or the environment.
- `environment/` — the **sandbox** the agent works in: it receives the challenge
  prompt + data and uses Python to produce a submission. See
  `environment/README.md`.

Run the pipeline commands from inside `agent/`, and the setup scripts from inside
`agent/setup/`.

## Implemented tasks

- `spam1`: spam/ham email classification for unit `01-spam`, task 1.
  - Downloads `spam1-train.zip` and `spam1-test.zip`.
  - Trains a stdlib-only clipped-count Multinomial Naive Bayes text model over
    word tokens and character 3-grams.
  - Writes predictions as `path;label`, matching the SmartLab expected format.

## Quick start on the SmartLab VM

From this directory:

```bash
cd agent
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

For every new SmartLab task, add a new module in
`agent/smartlab/tasks/<task>.py` with this minimal interface:

```python
def download(force: bool = False) -> None: ...
def validate(...) -> float: ...
def solve(output_path: Path) -> Path: ...
```

Then register it in `agent/smartlab_agent.py`'s `TASKS` dictionary.

Recommended workflow per exercise:

1. Read the task page and identify train/test URLs and expected submission
   format.
2. Implement a task plugin that downloads data into `data/raw/`.
3. Build a baseline solver and a validation split using the official metric.
4. Generate a deterministic submission in `submissions/`.
5. Record validation score, command, and assumptions in `reports/`.

## Auth/session fetching for the lab website

`agent/setup/fetch_lab.py` automates the normal CSRF + login-cookie flow for the
SmartLab web UI. It is stdlib-only and writes a Netscape-format cookie jar that
both Python and `wget` can reuse. Run it from inside `agent/setup/`:

```bash
cd agent/setup
```

Fetch only a fresh CSRF token/cookie from the login page:

```bash
python3 fetch_lab.py --insecure csrf
```

Create or refresh a logged-in session cookie file:

```bash
export LAB_USER='your_username'
export LAB_PASS='your_password'
export LAB_INSECURE_TLS=1   # needed for the lab's self-signed cert
python3 fetch_lab.py --insecure login
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

`agent/setup/smartlab_submit.py` is the one-stop Python CLI for challenge
setup/testing of submissions. It uploads `output.csv` plus a source archive,
then re-fetches the task page and returns a compact score signal. (At runtime
the agent submits via the pi tool `agent/tools/smartlab.ts`, not this script.)
Run it from inside `agent/setup/`.

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

## Mirroring a task page

To mirror an authenticated task page, fetch it through `agent/setup/fetch_lab.py`,
which
reuses `lab-cookies.txt` and re-logs in if the session expired:

```bash
python3 fetch_lab.py --insecure get 'TASK_URL' -o downloaded_task_page/task.html
```

## pi agent tool

The agent-facing surface is intentionally minimal: a single, self-contained pi
tool that submits a finished prediction CSV and returns the score. Task
solving/listing is handled earlier in the pipeline (see the sections above), and
login / CSRF / session handling happens automatically inside the tool — it is
not exposed.

`agent/tools/smartlab.ts` is a native TypeScript extension (no Python, no
subprocess). It ports the SmartLab auth + upload + Attempts-table parsing logic
and registers one tool via `pi.registerTool()`. It is wired into
`.pi/settings.json`, so every pi session started in this repo loads it
automatically once the project is trusted (no `-e` flag needed).

For a one-off test without the project settings you can still run:

```bash
pi -e agent/tools/smartlab.ts
```

### Tool: `smartlab_submit`

Uploads the CSV as `output.csv` plus an in-memory `source.zip`, polls the task's
Attempts table, and returns a compact score signal.

Parameters:

| Param | Required | Description |
| --- | --- | --- |
| `csv` | yes | Path to the prediction CSV to upload |
| `task_url` | no | Full task URL (defaults to `SMARTLAB_TASK_URL`) |
| `comment` | no | Attempt comment |
| `source_dir` | no | Directory archived as `source.zip` (default: project root) |
| `poll_timeout` | no | Seconds to poll for the result (default 180) |
| `poll_interval` | no | Seconds between polls (default 10) |

Required environment (used behind the scenes, never passed as tool args):

```bash
export LAB_USER='your_username'
export LAB_PASS='your_password'
export LAB_INSECURE_TLS=1        # the lab uses a self-signed certificate
export SMARTLAB_TASK_URL='https://lab-test.smartlab.mlsec.tu-berlin.de/units/.../tasks/.../'
```

The tool returns the same compact JSON as documented under "Upload and score
fetching" above (`ok`, `upload_ok`, `current_score`, `previous_scores`,
`improved`, `format_error`, try counts, ...).
