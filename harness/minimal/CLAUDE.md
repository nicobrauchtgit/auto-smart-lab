# Working on the minimal arm

This arm runs through `./dev bun run experiment -- --arm minimal` from the repository
root, which copies it to a fresh `runs/minimal/<stamp>/` and confines it there. See
`docs/experiment.md` at the root. Commands below that use `npm`, `scripts/vm` or the lab VM
are from before the merge; the lab VM no longer exists.

Read `docs/AGENT.md` first (what/why/how) and `docs/EXPERIMENT_LOG.md` (what has been run).
`README.md` is the usage guide.

Rules that are easy to break by accident:

- **Every measured run starts from scratch**: `npm run reset` (or `npm run solve-units`, which
  resets itself). A run that reuses a solver module, memory or a CSV is not a result.
- **No coaching in `agent/instructions/` or in orchestrator feedback.** Environment facts and
  protocol only. If you find yourself writing "try X" or "keep sweeps small", stop — that belongs
  to the separate coached agent, not this one.
- **Never give an LLM session a way to submit.** Submission is `submit_session.ts`, after the deterministic output check (`output_check.ts`).
- **The lab no longer accepts uploads (since 2026-11):** runs use `--offline`, which delivers each
  task's final result to `logs/deliveries/<stamp>/<task>/`; the user sends it to the instructor by
  hand. Record returned scores in `docs/instructor_scores.json`. Never send anything yourself.
- Harness bugs must be fixed; model failure modes are results — record them in the experiment
  log, do not paper over them with prompt hints.

Long and malware runs go to the lab VM via `scripts/vm/remote.sh` (VPN needed); watch them with
`scripts/vm/remote.sh status --watch` or `npm run status` locally.

Practicalities: load secrets with `set -a; source .env; set +a`; the lab needs the TU VPN; lab
TLS verification is off by default (self-signed); GWDG quota is 30/min, 200/hour, 1000/day, 3000/month, so at most two
to three solver runs per hour; only `qwen3-coder-next`, `openai-gpt-oss-120b` and
`devstral-2-123b-instruct-2512` support tool calling on GWDG; Gemini models run via `--model google-vertex/<id>`
(paid, use `--max-cost`; gcloud is in /opt/homebrew/share/google-cloud-sdk/bin). The local open model runs via
`--model mythllm/qwen3.8-flash-next-a5b` (chair's LiteLLM, no VPN, token `LITELLM_TOKEN`; provider entry in README). Append every run to `docs/EXPERIMENT_LOG.md`
and update `docs/AGENT.md` when behaviour or rules change.
