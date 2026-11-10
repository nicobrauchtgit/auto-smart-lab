# Project-local PI agent

This directory is the isolated PI agent home for this repository. `mise.toml`
sets `PI_CODING_AGENT_DIR` to this path (for every command run through `./dev`), so sessions, credentials, and model state do
not use or change the user's global PI setup.

The tracked `models.json` defines the SAIA/GWDG OpenAI-compatible endpoint and
the default `saia/mistral-medium-3.5-128b` model. It deliberately
references `SAIA_API_KEY` rather than storing a secret.

Put the key in `.env` (`SAIA_API_KEY=...`); `./dev` loads it. Then start PI:

```bash
./dev mise run pi
```

The runtime credential files, session logs, locks, and model cache are ignored
by Git.
