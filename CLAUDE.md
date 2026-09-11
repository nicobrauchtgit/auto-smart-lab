# Working in this repo

Read `docs/AGENT.md` first (what/why/how) and `docs/EXPERIMENT_LOG.md` (what has been run).
`README.md` is the usage guide.

Rules that are easy to break by accident:

- **Every measured run starts from scratch**: `npm run reset` (or `npm run solve-units`, which
  resets itself). A run that reuses a solver module, memory or a CSV is not a result.
- **No coaching in `agent/instructions/` or in orchestrator feedback.** Environment facts and
  protocol only. If you find yourself writing "try X" or "keep sweeps small", stop — that belongs
  to the separate coached agent, not this one.
- **Never give an LLM session a way to submit.** Submission is `submit_session.ts`, after eval.
- **Real submissions spend one of 3 attempts per task**; use `--no-submit` unless the user asked
  for a submission. Check the task page's "N of 3 attempts used" before a run with submissions.
- Harness bugs must be fixed; model failure modes are results — record them in the experiment
  log, do not paper over them with prompt hints.

Practicalities: load secrets with `set -a; source .env; set +a`; the lab needs the TU VPN; lab
TLS verification is off by default (self-signed); GWDG quota is 30/min, 200/hour, so at most two
to three solver runs per hour; only `qwen3-coder-next`, `openai-gpt-oss-120b` and
`devstral-2-123b-instruct-2512` support tool calling. Append every run to `docs/EXPERIMENT_LOG.md`
and update `docs/AGENT.md` when behaviour or rules change.
