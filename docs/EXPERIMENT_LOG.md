# Experiment log

Append-only record of measured runs. One entry per run: date, task, model, start state, what the
agent did, result on the platform, incidents. Local validation scores are the agent's own holdout
estimate; **platform** scores are what the lab returned. Scores are balanced accuracy for the spam
unit. Attempts are per task, max 3, on `lab-test.smartlab.mlsec.tu-berlin.de` (team "Mystic Miners").

See `docs/AGENT.md` for what the agent is and the rules a valid run must follow (from scratch, no
coaching). Runs before those rules existed are marked as such.

---

## 2026-09-10

Model for every run: `gwdg/qwen3-coder-next`. Harness at commits a4fdc91 … 9521382 (see git log).

| # | Task | Start state | Prompt variant | Solver | Local | Platform | Attempts | Outcome |
|---|---|---|---|---|---|---|---|---|
| 1 | spam1 | pre-existing solver (invalid: not from scratch) | coached | 37s, 10 calls | 0.9919 | — (`--no-submit`) | 0/3 | pipeline check only |
| 2 | spam1 | clean | coached | 3m35s, 27 calls | 0.9958 | — (`--no-submit`) | 0/3 | dry run |
| 3 | spam2 | clean | coached | 30m cap, 89 calls | 0.9051 at cap | — | 0/3 | **timed out**, nothing submitted (harness then treated timeout as fatal; fixed) |
| 4 | spam2 | clean | coached | 8 min then stopped | 0.974 | 0.9601 / 0.9593 / 0.9601 | **3/3** | solver called the submit tool itself, bypassing eval; tool removed from sessions afterwards |
| 5 | spam3 | clean | coached | 8m35s, 36 calls (incl. 400s rate-limit sleep) | 0.9955 | **0.9906** | 1/3 | solved first attempt |
| 6 | spam1 | clean | coached | 14.2 min, via `solve-units` | 0.9946 | — (`--no-submit`) | 0/3 | batch driver check |
| 7 | spam1 | clean, via `solve-units` | coached | 30m cap, 95 calls → **salvage** (validate 0.9903 + solve, ~12 min) | 0.9903 | **0.9735** | 1/3 | solved via salvage path; per-minute 429s early on |
| 8 | spam1 | clean | **barebones** | aborted by me: degenerate loop (`memory_append_session` ×46) after 0.9949 local | 0.9949 | — | 0/3 | led to loop guard |
| 9 | spam1 | clean | **barebones** | 29m19s, 39 calls (41 s before cap) | 0.9895 | — (`--no-submit`) | 0/3 | protocol check for the barebones prompt |

**State of the lab after this day:** spam1 1/3 used (best 0.9735), spam2 3/3 used (best 0.9601),
spam3 1/3 used (best 0.9906). `solve-units` skips all three until units change or `--retry-solved`.

**Observations**

- Same model, same task, wide variance: spam1 took 3.5 min / 0.9958 (run 2) and 30 min / 0.9903
  (run 7) under the same coached prompt.
- Coached vs barebones on spam1, one sample each: 3.5 min / 0.9958 vs 29 min / 0.9895. Not
  significant, but the direction is the one the two-agent comparison should test properly.
- Every run that reached the platform cleared 0.97 on the first upload (spam1 0.9735, spam3 0.9906),
  so the below-target re-solve loop has not fired in a real run yet.
- API: transient 500s and request timeouts in run 1; per-minute 429s in runs 7; hourly quota hit
  once (run 5, 400 s sleep). All recovered automatically.
- Runs 8 and 9 were executed from a shell whose `python3` had fallen back to Apple's 3.9; that
  contributes to their slow validate/solve times and is not a property of the agent.

**Harness fixes made during the day** (all committed): task-ID ordering, empty prompt extraction,
logout-on-relogin, `--no-submit`, `--target` iteration loop, `--solver-timeout` + salvage,
`--max-attempts`, submit tool removed from LLM sessions, `npm run reset`, `npm run solve-units`,
TLS verification off by default, degenerate-loop guard, memory dedupe, coaching stripped.
