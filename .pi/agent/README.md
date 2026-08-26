# Project-local PI agent

This directory is the isolated PI agent home for this repository. Devbox sets
`PI_CODING_AGENT_DIR` to this path, so sessions, credentials, and model state do
not use or change the user's global PI setup.

The tracked `models.json` defines the SAIA/GWDG OpenAI-compatible endpoint and
the default `saia/mistral-medium-3.5-128b` model. It deliberately
references `SAIA_API_KEY` rather than storing a secret.

Before starting PI, provide the key in the shell that launches Devbox:

```bash
export SAIA_API_KEY='...'
devbox shell
devbox run pi
```

The runtime credential files, session logs, locks, and model cache are ignored
by Git.
