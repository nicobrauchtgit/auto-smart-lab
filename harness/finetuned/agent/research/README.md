# Research: data profile and solution brief

> Superseded by [expert-team-v2.md](../../docs/expert-team-v2.md) section 3 when P6/P7 land: the research stage, its brief and `check_brief` are replaced by data and ideas scouts that return bullets. Accurate for the current code until then.

Research turns a task and its data into a short **solution brief**: one
recommended scikit-learn pipeline tailored to the dataset, at most a few ranked
alternates, and a few atomic next improvements. Solve starts from the
recommendation, and harness hold-out measurements decide what wins. The reasons
for this design were recorded in the 2026-11 research redesign, superseded by
[expert-team-v2.md](../../docs/expert-team-v2.md).

Course material under the repository's `resources/<unit>/` is declared in a
checksummed manifest, validated by the `course-resources` preflight and copied
into read-only `resources/` in the research workspace. `context.json.resources`
and stage input records identify every supplied file. The spam unit includes
the user-supplied exercise and performance-measure slides, with page-labelled
text copies. Course citations support methods/context, never measured dataset
facts. See [the resource guide](../../../../resources/README.md).

## 1. Harness data profile

Before the agent starts, `profile.ts` runs `python/data_profile.py` over the
declared training and test data and writes `profile/profile.json` into the
research workspace. It runs over the full corpus and is deterministic, taking
about 8 s per spam task.

- **Generic layer (all tasks):**
  - per-split inventory and size quantiles;
  - content type by magic bytes and encoding;
  - exact duplicates within and across splits;
  - target counts, and duplicates whose targets conflict;
  - how well member-name suffixes or directories predict the target;
  - target distribution by archive order;
  - training-vs-test name suffixes.
- **Text layer:** added when at least 90% of the samples in both splits are
  text. It covers line and URL counts and HTML/email-header rates, per split
  and per target.
- **Network captures:** only inventory for now.

Each record has `split`, `scope`, `population`, `method` and `values`. Only
aggregates are stored: never contents, member names or name-to-label maps. A
failed profile is reported as a `data_profile` input with status
`unavailable`, and the agent runs without it; the stage does not fail. The
`data-profile` preflight check verifies that the scripts are present.

## 2. The brief

`agent/prompts/research/system.md` defines the format. The validator in
`validate.ts` enforces it.

- **Sections:** `# Brief`, the context snapshot line, Dataset facts,
  Recommended pipeline, Alternates, Next improvements, Leakage and risks,
  Sources.
- **Route caps** come from `harness.config.json` (`maxFacts`, `maxAlternates`,
  `maxImprovements`). `maxReportBytes` is only a loose safety limit.
- **Sources** are written in brackets: `[profile:<key>]`,
  `[analysis/<file>.json#<key>]`, `[analysis/<file>]` or a URL.
  - Every source must resolve inside the workspace.
  - Every number in a dataset fact or risk must appear in the data it cites.
    Rounding, percentages, thousands separators and KB/MB are allowed.
  - Every URL must be one that `web_search` returned. The tool appends them to
    `.harness/web_sources.jsonl`.
  - Each dataset fact needs a dataset source, and so does the recommended
    pipeline.
- **Self-check:** the agent's `check_brief` tool runs the same validator, so
  the agent can fix problems before it stops. Each check is recorded as a
  `brief_self_check` event.

## 3. Budget and outcome

Research has an action budget, not a time limit: `research.maxToolCalls` tool
calls, shared by the initial and the repair attempt (`budget.ts`).
- **Visible budget:** after every tool result the agent sees the calls used and
  left, with guidance that changes as the budget shrinks: explore, then focus,
  then write the brief now.
- **Running out:** only reading, writing or editing `research.md` and
  `check_brief` remain, for `research.finalizeToolCalls` calls. Then every tool
  is blocked.
- **Outcome:**
  - a brief that passes every check is complete;
  - an incomplete or unchecked brief is **partial** (`validation.partial`), and
    the run continues: solve is told the brief is partial;
  - the stage fails only if the session broke before any tool call or
    document change, so there is nothing to hand on.
- **Observability:** each phase change, blocked call and the final budget use
  is recorded (`research_budget_phase`, `research_budget_blocked`,
  `research_finished`).

The session runner no longer has a 30-minute limit. A model request with no
streamed output for `session.stallMs` is cancelled and resumed in the same
conversation, at most `session.stallRetries` times (`model_stall`,
`model_stall_retry`). `session.maxWallMs` is only a safety limit. See
[the configuration reference](../../docs/configuration.md).

These checks make claims verifiable; they do not prove every inference true.
They are also not tamper-proof: the agent's shell can reach the workspace,
including the search log.

The startup label profile is still injected into the opening prompt. Existing
`research.md` files are prior work: the agent verifies and updates them, and an
old-format report fails validation until it is rewritten as a brief.
