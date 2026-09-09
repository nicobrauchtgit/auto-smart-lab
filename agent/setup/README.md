# Setup commands

`python_environment.py` manages the shared Devbox Python dependencies. Pipeline
agents may run its `inspect`, `add`, and `update` commands. See
[the Python runtime documentation](../runtime/python/README.md) for setup,
dependency changes, and audit records.

## Challenge setup

These scripts talk to the SmartLab website to **set up challenges**: login,
data download, inventory, and result upload. They are deliberately kept out of
the agent pipeline and out of the agent's `environment/` sandbox — the agent
must never import or run them.

The active unit fetcher is a TypeScript pipeline module that fetches one
complete unit at a time:

```bash
npm run fetch-unit -- 01-spam
```

To refresh prompts and metadata while retaining matching archives:

```bash
npm run fetch-unit -- 01-spam --refresh-metadata
```

It can also be imported by other pipeline code:

```typescript
import { fetchUnit } from "./fetch_unit.ts";

await fetchUnit("01-spam");
```

It writes every task prompt, metadata, downloaded dataset, extracted ZIP, and
updates `units/index.json`. Existing archives are retained on interrupted runs;
`--refresh-data` explicitly replaces them.

- `fetch_unit.ts` — fetch one unit and all of its tasks/data.
- `lab_client.ts` — reusable authenticated SmartLab HTTP client.
- `fetch_lab.py` — stdlib-only login / CSRF / cookie handling.
- `inspect_lab_data.py` — inventory units, challenges, and data links.
- `submit.py` — submission helpers (task-page parsing, upload).
- `smartlab_submit.py` — one-stop upload + score CLI (uses `submit` + `fetch_lab`).

Run them from inside this directory so sibling imports resolve:

```bash
cd agent/setup
export LAB_USER=... LAB_PASS=... LAB_INSECURE_TLS=1
python3 fetch_lab.py --insecure login
python3 smartlab_submit.py upload 'TASK_URL' path/to/output.csv --insecure --json
```

Note: agent-facing submission at runtime goes through the pi tool
`../tools/smartlab.ts`, not these Python scripts.
