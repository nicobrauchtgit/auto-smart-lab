# Setup commands

`python_environment.py` manages the shared project Python dependencies. Pipeline
agents may run its `inspect`, `add`, and `update` commands. See
[the Python runtime documentation](../runtime/python/README.md) for setup,
dependency changes, and audit records.

## Challenge setup

These scripts talk to the SmartLab website to set up challenges: login,
data download and inventory. Runtime agents do not import or run them;
the controller uses the shared setup path.

The active unit fetcher is a TypeScript pipeline module that fetches one
complete unit at a time:

```bash
./dev bun run fetch-unit -- 01-spam
```

Every explicit fetch reads live unit and task pages, retaining matching local
archives. The legacy `--refresh-metadata` flag remains accepted. Old HTML caches
and local archive hashes cannot hide newly published download links. Network,
authentication and description failures leave existing local files unchanged;
required pages are fetched and validated before writes begin.

It can also be imported by other pipeline code:

```typescript
import { fetchUnit } from "./fetch_unit.ts";

await fetchUnit("01-spam");
```

It writes task prompts, metadata and page caches, and updates `units/index.json`.
It records download links without downloading or extracting sample archives.
`task_data.ts` downloads only the current run's missing task files on demand.

- `fetch_unit.ts` — refresh one unit and all of its task metadata.
- `lab_client.ts` — reusable authenticated SmartLab HTTP client.
- `inspect_lab_data.py` — inventory units, challenges, data links, local
  services and API endpoints (uses `fetch_lab.py` for login). Kept until its
  service and endpoint detection moves into `fetch_unit.ts`; see
  `docs/cleanup-plan.md`.

Uploads go through the submit stage (`agent/submission/`), which keeps the
durable attempt ledger.
