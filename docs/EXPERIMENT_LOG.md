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

---

## 2026-09-13/14 — Unit 2 "Malicious Code in Documents" (02-maldoc), barebones prompt

The lab now lists 6 units / 15 tasks (defense1, offense1-2, code1-3, attacks1-2, spam1-3, documents1-4).
Fetched ~24 GB. Two `solve-units --only documents1..4` runs, model `qwen3-coder-next`, real submissions.

| Run | Task | Solver | Local | Platform | Attempts | Outcome |
|---|---|---|---|---|---|---|
| A | documents1 (DOCX) | 2 × 30 min cap, no module after session 1; session 2 module crashed in salvage | — | — | 0/3 | solver-failed (60.6 min) |
| A | documents2 (PDF) | 6 min, then hourly API quota exhausted by documents1 | — | — | 0/3 | fatal: rate-limit wait > 15 min cap (**harness bug, fixed: cap now 65 min**) |
| A | documents3, documents4 | quota still exhausted | — | — | 0/3 | fatal, same cause |
| B | documents1 (DOCX) | 6.9 min | 0.9325 | **0.976** | 1/3 | solved, first attempt |
| B | documents2 (PDF) | 32 min cap, no module; second session started | — | — | 0/3 | **run stopped by hand**, see below |

**Run B was stopped because the dataset was being destroyed underneath the agent.** Microsoft
Defender on the machine quarantined **1505 files** from the extracted corpus during the runs
(docx: 9270 → 8361 files on disk; pdf: 9039 → 8852). The zips themselves were untouched. The
documents1 CSV still had all 2969 test rows, so its 0.976 is probably valid, but any later result on
this machine would be measured on a shrinking, non-random subset (Defender removes the *malicious*
samples). The earlier "macOS security issue with the malicious file" the agent complained about was
this. **Do not run the malware units on a Defender-managed Mac**; see AGENT.md §3.6.

Other fixes from this day: `fetch_units` extracts archives member by member (rtf-train.zip has one
corrupt CRC entry that aborted `extractall`); task-id column widened in the results table.

---

## 2026-09-27 — preparing VM runs; monthly API quota exhausted

No measured run. The GWDG key's **monthly quota (3000 requests) is used up** until 2026-10-01 00:00
UTC; a short local test run died on it, which showed the harness reported it as a confusing
"rate limit exceeds max wait" crash. Fixed: the model pre-check reads the quota headers and exits
with code 4, `solve-units` stops the batch instead of failing every task. Added live monitoring
(`logs/status/*.json`, `npm run status`) and the VM tooling (`scripts/vm/`); the bootstrap was
verified in a clean Ubuntu 24.04 container. The VM itself was not reachable (no VPN) and is untested.
Remaining unit 2 tasks (documents2–4, 0/3 attempts each) are to be run on the VM once quota returns.

**2026-09-28:** VM is `stud03` (not `stud33`). First deploy succeeded (Node installed without sudo,
lab login ok, no AV). Started fetching the documents unit on the VM. Found that the lab's student VM
provides numpy/scipy/scikit-learn/torch by default, contradicting the prompt's "stdlib only";
see AGENT.md §3.7. No measured run: monthly API quota still exhausted until 2026-10-01.

**Condition change, 2026-09-28:** the solver is no longer told "stdlib only". Its first message now
states the detected Python runtime (on the VM: the lab's `~/env` venv with numpy, scipy,
scikit-learn, pandas, torch, tensorflow; pip allowed). **Runs from here on are not directly
comparable with the earlier stdlib-only runs**; tag entries with the condition.

---

## 2026-10-01 — Google models connected

gcloud CLI installed, signed in, ADC created. Probe sessions (one bash tool call each) through
`session_runner` succeeded on `google-vertex/gemini-3.1-pro-preview` (7 s, $0.008),
`gemini-3.7-flash` (3 s, $0.002) and `gemini-2.5-flash` (1 s, $0.001). No task run yet.

**2026-10-02:** VM deployed with the personal gcloud ADC (`deploy --with-gcloud-adc`, temporary until a
project service account exists). Probe sessions on the VM: gemini-3.7-flash and gemini-3.1-pro-preview
both completed a tool call. GWDG monthly quota has reset (2779 left). VM disk: 8 GB free.

**2026-10-02, Langfuse test (not a measured run):** documents4 on the VM, gemini-3.7-flash,
`--no-submit --solver-timeout 5 --max-cost 1`. Both 5-min solver sessions timed out without a module
(expected at that cap), outcome `solver_failed`. Langfuse session `documents4-20261002T194015-148d9c`:
4 stage traces, 44 generations with model `gemini-3.7-flash`, 44 tool calls, cost $0.230 (harness log:
$0.229), scores `outcome=solver_failed`, `submissions=0`. Tracing works end to end on the VM.

---

## 2026-10-02 — Unit 2 on the VM with Gemini 3.1 Pro (runtime: lab venv, barebones prompt)

`remote.sh start --only documents2,documents3,documents4 --model google-vertex/gemini-3.1-pro-preview --max-cost 20`,
real submissions, documents1 skipped (already solved, 0.976). A first launch (19:55) ran with the system
`/usr/bin/python3` instead of `~/env` because of a quoting bug in `remote.sh start`; it was stopped in the
solver phase after $0.16, no submission, and relaunched at 19:59 after the fix (logs/solve-units/2026-10-02T19-59-01).
documents2, session 1: Gemini reached 0.978 local, wrote the CSV, then wrote its memory entry as a JSON
*string* six times (each acknowledged "Memory updated.") until the loop guard aborted the session. Salvage
then missed the CSV (harness bug: path resolved against the repo root instead of `agent/`; fixed in 0f9cca8),
so a second session re-ran solve; it started writing `tasks.documents2 = null` repeatedly. Fix (tool
correctness, applies to sessions started after the VM pull): `memory_write` now rejects such patches with
an explicit error. That did not stop the loop: Gemini kept sending the same JSON text, because the
tool's untyped nested `patch` parameter cannot be filled with an object under Gemini's constrained tool
calling (harness issue, not model behaviour). documents2 then crashed when its *eval* session hit the same
loop (unhandled; harness bug) after attempt 1 scored **0.6583** on the platform (local 0.978; training
data 2016-07/2017-01, test 2017-09: temporal shift, 66% vs 17% predicted malicious); its second
candidate (local 0.976) was never evaluated. Fixes in the commit after 51f080e: typed flat
`memory_write` parameters (verified with gemini-3.7-flash and 3×gemini-3.1-pro-preview), eval retry.
documents3: attempt 1 platform **0.9382** (local 0.983).

**Restarted batch, 2026-10-02 22:40 → 2026-10-03 ~03:00, fixed code, cap $17, spent $8.96.** Final lab state:

| Task | Platform scores (all attempts, both batches) | Best | Local scores | Notes |
|---|---|---|---|---|
| documents2 PDF | 0.6583, 0.6483, 0.6776 | 0.6776 | 0.973–0.978 | temporal shift (train 2016/early 2017, test late 2017) never addressed |
| documents3 RTF | 0.9382, 0.9498, 0.9483 | 0.9498 | 0.979–0.987 | **12 consecutive re-solves produced byte-identical CSVs** (≈3 h): the identical-CSV guard makes re-solving free and unbounded |
| documents4 Mixed | 0.8334, 0.783, 0.7952 | 0.8334 | 0.982–0.988 | session 3 hit the 30-min cap, salvage produced attempt 3 |

No memory loops, eval crashes or harness crashes after the fixes. Every local score was ≥ 0.97 while every
platform score was below it: the agent's random-split validation never predicted the platform result, and
the eval agent (which only sees the local score) approved every candidate. Harness issue found: no cap on
consecutive re-solves that reproduce the last submission. Fixed afterwards: `--max-unchanged` (default 3).

---

## 2026-10-03 — Harness: run conditions, report, eval facts and caps, token tasks (4db6b6c)

Changes (see AGENT.md 3.2): every task run records its conditions (commit, prompt hashes, model, host,
runtime, caps); `npm run report` tabulates all batch results; the eval agent's first message states the
candidate, the attempts used and the platform history (synced from the task page at start); a missing
`EVAL_DECISION` line is a failed eval instead of an approval; `--max-rejections` (default 3, exit 8) and
`--no-eval`; `fetch_units.py` records the metric and the submission kind; token tasks (adversarial ML) log
the local service's token via the task page's form (verified up to the form, no token logged yet); the
solver is told the host OS instead of "macOS"; reported CSV paths are resolved against the repo root or `agent/`.

**Smoke test (not a measured result, ran on the pre-commit working tree c929d80+):** attacks2 (adversarial
example detection, BACC, no training labels) on the Mac, `solve-units --only attacks2 --no-submit
--model gwdg/qwen3-coder-next --solver-timeout 25`, 62.7 min including a 29-min hourly-quota wait.
Three solver sessions (Isolation Forest ensembles on pixel statistics; local 0.929, 0.929, 0.806, a score
it derived from the `.0`/`.x` file-name suffixes), three eval rejections (the eval rubric needs 0.97 with 3
attempts left), then exit 8 `eval-rejected`, nothing submitted. Each solver result went through salvage
because the solver reported `csv=submissions/…` relative to `agent/` (harness bug, fixed in 4db6b6c).
Model observations: the CSV lines are `name.x;label` while the task prompt's example is
`adv-test/name.x;label`, and the eval agent called the format valid; the solver also wrote a
`SOLVER_DONE.txt` into the repo root.
