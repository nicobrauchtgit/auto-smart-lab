# Setup commands

`python_environment.py` manages the shared project Python dependencies. Pipeline
agents may run its `inspect`, `add`, and `update` commands. See
[the Python runtime documentation](../runtime/python/README.md) for setup,
dependency changes, and audit records.

## Challenge setup

These scripts talk to the SmartLab website to **set up challenges**: login,
data download and inventory. They are deliberately kept out of the agent
pipeline; the agent must never import or run them.

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
- `inspect_lab_data.py` — inventory units, challenges, data links, local
  services and API endpoints (uses `fetch_lab.py` for login). Kept until its
  service and endpoint detection moves into `fetch_unit.ts`; see
  `docs/cleanup-plan.md`.

Uploads go through the submit stage (`agent/submission/`), which keeps the
durable attempt ledger.
