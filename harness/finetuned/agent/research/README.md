# Research inputs: data profile, task context and course resources

The research stage, its solution brief, `check_brief` and the research budget
were removed on 2026-11-11. Under
[expert-team-v2.md](../../docs/expert-team-v2.md) the data and ideas scouts
take their place (P7a). This folder keeps the inputs those scouts will read:

- `profile.ts` and `python/data_profile.py`: the harness data profile;
- `context.ts`: the task context (task text, dataset inventory, declared
  training/test inputs, course resources) and its hash;
- `resources.ts`: course resources from the repository's `resources/<unit>/`;
- `startup_context.ts`: label and family summaries of the training targets.

The scout dry run (`agent/dryrun/scout_dry_run.ts`) uses all four.

## Course resources

Course material under `resources/<unit>/` is declared in a checksummed
manifest, validated by the `course-resources` preflight and copied read-only
into a workspace's `resources/`. The spam unit includes the user-supplied
exercise and performance-measure slides with page-labelled text copies. Course
material supports methods and context, never measured dataset facts. See
[the resource guide](../../../../resources/README.md).

## Harness data profile

`profile.ts` runs `python/data_profile.py` over the declared training and test
data and writes `profile/profile.json` into a workspace. It covers the full
corpus and is deterministic, taking about 8 s per spam task.

- **Generic layer (all tasks):**
  - per-split inventory and size quantiles;
  - content type by magic bytes and encoding;
  - exact duplicates within and across splits;
  - target counts, and duplicates whose targets conflict;
  - target distribution by archive order;
  - training-vs-test name suffixes.
- **Text layer:** added when at least 90% of the samples in both splits are
  text. It covers line and URL counts and HTML/email-header rates, per split
  and per target.
- **Network captures:** only inventory for now.

The profile no longer measures how well name suffixes predict the target:
training names end in their label by construction (the task texts say so), so
that measurement only invited a false leak finding.

Each record has `split`, `scope`, `population`, `method` and `values`. Only
aggregates are stored: never contents, member names or name-to-label maps. A
failed profile is reported as unavailable and is not an error. The
`data-profile` preflight check verifies that the scripts are present.
