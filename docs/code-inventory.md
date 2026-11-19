# Generated source inventory

Regenerate from the repository root: `./dev bun scripts/code-inventory.ts`.
Check freshness: `./dev bun scripts/code-inventory.ts --check`. Category fixtures: `./dev bun scripts/code-inventory.ts --self-test`.

Source snapshot SHA-256: `167663c51c9972eed7bcee64ba4d3a547e830b4fac8ff41543fb1b60a31501ae`.
Generator SHA-256: `f94d84237717b5c47d5ea88941d68c2247e25ec907cb4f92c5bf19998bb61be3`.
Parser: TypeScript 7.0.2; Python 3.13.13.

## Scope and interpretation

Only git-tracked TS/JS (including JSX, TSX, m/c variants) and Python under harness/, experiment/, scripts/, plus docs/redesign-*-reference.py are read. Working-tree bytes, including staged edits, are measured; add new sources to the index before regenerating. Other root code, Markdown, JSON, shell and lockfiles are outside the metrics. Excluded: node_modules, vendor, generated, dist, build, coverage, runs, units, .tools, .venv, fixtures, __fixtures__, declaration .d.ts/.d.mts/.d.cts and .generated. files. Fixtures are excluded rather than assigned to production. Historical/legacy tracked source remains included. No run data, secrets or model APIs are read.

Physical lines count LF-delimited lines, including comments and blank lines; a trailing LF does not add a line, empty files count zero. CRLF counts once. TS/JS counts body-bearing function declarations, expressions, arrows, methods, constructors and get/set accessors, recursively including anonymous callbacks and nested functions. Signatures/overloads without bodies and function types are excluded; a default constructor is not invented. Python ast counts def, async def and lambda recursively, including methods and nested definitions. Classes count declarations/expressions in TS/JS and ClassDef in Python. Counts describe syntax, not unique behavior, complexity or quality.

Test/support means tests/ or __tests__/ paths, test_*.py, *.test.* or *.spec.*, and testing.* or fixture-live.* helpers. All other included source is labelled production/tooling, including development scripts and hand-made references; this heuristic is not a runtime-reachability claim. Module groups are arm agent subdirectory (loose files: entrypoints) or top-level source directory.

The source digest hashes sorted path + NUL + byte length + NUL + bytes + NUL per included file. The report itself and commit IDs are excluded: committing a report cannot invalidate it. Generator identity is also recorded separately. There are no timestamps or machine paths in the output; identical inputs and parser versions produce identical output.

## Totals by arm, language and role

| Arm | Language | Role | Files | Lines | Callables | Classes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| finetuned | Python | production/tooling | 51 | 7800 | 350 | 23 |
| finetuned | Python | test/support | 18 | 3183 | 285 | 41 |
| finetuned | TypeScript | production/tooling | 140 | 19772 | 2081 | 24 |
| finetuned | TypeScript | test/support | 103 | 14113 | 2691 | 4 |
| minimal | Python | production/tooling | 11 | 2036 | 96 | 8 |
| minimal | TypeScript | production/tooling | 21 | 4571 | 327 | 3 |
| shared/development | Python | production/tooling | 3 | 89 | 1 | 0 |
| shared/development | TypeScript | production/tooling | 5 | 649 | 71 | 1 |
| shared/development | TypeScript | test/support | 3 | 445 | 75 | 0 |

**All included source:** 355 files; 52658 physical lines; 5977 callables; 104 classes.

## Module and language totals (both roles)

| Arm | Module | Language | Files | Lines | Callables | Classes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| finetuned | agent/confirmation | TypeScript | 8 | 695 | 108 | 0 |
| finetuned | agent/context | TypeScript | 2 | 559 | 107 | 1 |
| finetuned | agent/entrypoints | TypeScript | 9 | 559 | 36 | 0 |
| finetuned | agent/evaluation | TypeScript | 1 | 2 | 0 | 0 |
| finetuned | agent/experiments | Python | 1 | 90 | 3 | 0 |
| finetuned | agent/experiments | TypeScript | 23 | 4219 | 550 | 3 |
| finetuned | agent/harness | TypeScript | 2 | 160 | 21 | 0 |
| finetuned | agent/libs | Python | 2 | 164 | 6 | 0 |
| finetuned | agent/pipeline | TypeScript | 24 | 3029 | 409 | 5 |
| finetuned | agent/prompts | TypeScript | 7 | 457 | 51 | 0 |
| finetuned | agent/refit | Python | 3 | 445 | 18 | 0 |
| finetuned | agent/refit | TypeScript | 8 | 997 | 122 | 0 |
| finetuned | agent/research | Python | 2 | 317 | 20 | 1 |
| finetuned | agent/research | TypeScript | 8 | 752 | 77 | 1 |
| finetuned | agent/run | Python | 1 | 233 | 8 | 0 |
| finetuned | agent/run | TypeScript | 27 | 4695 | 930 | 3 |
| finetuned | agent/setup | Python | 4 | 1233 | 77 | 8 |
| finetuned | agent/setup | TypeScript | 7 | 1194 | 138 | 1 |
| finetuned | agent/solve | Python | 1 | 42 | 0 | 0 |
| finetuned | agent/solve | TypeScript | 11 | 1022 | 146 | 0 |
| finetuned | agent/subagents | TypeScript | 10 | 1272 | 182 | 1 |
| finetuned | agent/submission | Python | 2 | 214 | 6 | 0 |
| finetuned | agent/submission | TypeScript | 8 | 591 | 133 | 1 |
| finetuned | agent/team | TypeScript | 23 | 3677 | 703 | 1 |
| finetuned | agent/telemetry | TypeScript | 10 | 933 | 159 | 6 |
| finetuned | agent/tools | TypeScript | 3 | 1147 | 75 | 1 |
| finetuned | agent/training | Python | 48 | 7831 | 468 | 52 |
| finetuned | agent/training | TypeScript | 47 | 7910 | 825 | 4 |
| finetuned | agent/workspace | TypeScript | 5 | 15 | 0 | 0 |
| finetuned | docs | Python | 5 | 414 | 29 | 3 |
| minimal | agent/entrypoints | Python | 1 | 94 | 3 | 0 |
| minimal | agent/run | TypeScript | 17 | 3146 | 237 | 2 |
| minimal | agent/setup | Python | 7 | 1843 | 85 | 7 |
| minimal | agent/smartlab | Python | 3 | 99 | 8 | 1 |
| minimal | agent/tools | TypeScript | 4 | 1425 | 90 | 1 |
| shared/development | docs | Python | 3 | 89 | 1 | 0 |
| shared/development | experiment | TypeScript | 7 | 996 | 123 | 1 |
| shared/development | scripts | TypeScript | 1 | 98 | 23 | 0 |

## Longest production/tooling files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/training/service.ts](../harness/finetuned/agent/training/service.ts) | 1230 | 98 | 1 |
| [harness/finetuned/agent/run/lead_session.ts](../harness/finetuned/agent/run/lead_session.ts) | 935 | 147 | 1 |
| [harness/finetuned/agent/experiments/supervisor.ts](../harness/finetuned/agent/experiments/supervisor.ts) | 931 | 84 | 1 |
| [harness/minimal/agent/tools/smartlab.ts](../harness/minimal/agent/tools/smartlab.ts) | 819 | 52 | 1 |
| [harness/finetuned/agent/tools/smartlab.ts](../harness/finetuned/agent/tools/smartlab.ts) | 807 | 52 | 1 |
| [harness/finetuned/agent/training/python/smartlab_trial/search.py](../harness/finetuned/agent/training/python/smartlab_trial/search.py) | 724 | 44 | 3 |
| [harness/finetuned/agent/training/python/worker.py](../harness/finetuned/agent/training/python/worker.py) | 716 | 26 | 1 |
| [harness/finetuned/agent/training/contract.ts](../harness/finetuned/agent/training/contract.ts) | 700 | 41 | 2 |
| [harness/finetuned/agent/training/results.ts](../harness/finetuned/agent/training/results.ts) | 640 | 46 | 0 |
| [harness/minimal/agent/run/orchestrate.ts](../harness/minimal/agent/run/orchestrate.ts) | 639 | 29 | 1 |
| [harness/minimal/agent/run/session_runner.ts](../harness/minimal/agent/run/session_runner.ts) | 564 | 35 | 0 |
| [harness/minimal/agent/setup/submit.py](../harness/minimal/agent/setup/submit.py) | 498 | 17 | 3 |
| [harness/minimal/agent/run/submit_session.ts](../harness/minimal/agent/run/submit_session.ts) | 491 | 54 | 1 |
| [harness/finetuned/agent/setup/fetch_unit.ts](../harness/finetuned/agent/setup/fetch_unit.ts) | 462 | 56 | 0 |
| [harness/finetuned/agent/pipeline/executor.ts](../harness/finetuned/agent/pipeline/executor.ts) | 417 | 19 | 0 |
| [harness/finetuned/agent/setup/python_environment.py](../harness/finetuned/agent/setup/python_environment.py) | 403 | 25 | 1 |
| [harness/minimal/agent/setup/fetch_units.py](../harness/minimal/agent/setup/fetch_units.py) | 400 | 25 | 0 |
| [harness/finetuned/agent/telemetry/runtime.ts](../harness/finetuned/agent/telemetry/runtime.ts) | 389 | 44 | 2 |
| [harness/minimal/agent/setup/fetch_lab.py](../harness/minimal/agent/setup/fetch_lab.py) | 373 | 21 | 3 |
| [harness/finetuned/agent/team/scouts.ts](../harness/finetuned/agent/team/scouts.ts) | 348 | 61 | 0 |

## Longest test/support files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/run/lead_session.test.ts](../harness/finetuned/agent/run/lead_session.test.ts) | 569 | 283 | 0 |
| [harness/finetuned/agent/training/python/test_worker.py](../harness/finetuned/agent/training/python/test_worker.py) | 512 | 33 | 1 |
| [harness/finetuned/agent/team/scouts.test.ts](../harness/finetuned/agent/team/scouts.test.ts) | 469 | 131 | 0 |
| [harness/finetuned/agent/team/integration.test.ts](../harness/finetuned/agent/team/integration.test.ts) | 359 | 52 | 0 |
| [harness/finetuned/agent/experiments/updates.test.ts](../harness/finetuned/agent/experiments/updates.test.ts) | 356 | 52 | 0 |
| [harness/finetuned/agent/training/results.test.ts](../harness/finetuned/agent/training/results.test.ts) | 346 | 50 | 0 |
| [harness/finetuned/agent/setup/tests/test_python_environment.py](../harness/finetuned/agent/setup/tests/test_python_environment.py) | 320 | 25 | 3 |
| [experiment/minimal.test.ts](../experiment/minimal.test.ts) | 318 | 57 | 0 |
| [harness/finetuned/agent/training/recovery.test.ts](../harness/finetuned/agent/training/recovery.test.ts) | 309 | 64 | 0 |
| [harness/finetuned/agent/context/session.test.ts](../harness/finetuned/agent/context/session.test.ts) | 308 | 81 | 0 |
| [harness/finetuned/agent/pipeline/run_pipeline.test.ts](../harness/finetuned/agent/pipeline/run_pipeline.test.ts) | 303 | 55 | 0 |
| [harness/finetuned/agent/run/agent_shell.test.ts](../harness/finetuned/agent/run/agent_shell.test.ts) | 300 | 63 | 0 |
| [harness/finetuned/agent/experiments/supervisor.test.ts](../harness/finetuned/agent/experiments/supervisor.test.ts) | 282 | 57 | 0 |
| [harness/finetuned/agent/team/shell_supervision.test.ts](../harness/finetuned/agent/team/shell_supervision.test.ts) | 278 | 56 | 0 |
| [harness/finetuned/agent/training/python/test_anchored_batch.py](../harness/finetuned/agent/training/python/test_anchored_batch.py) | 276 | 20 | 4 |
| [harness/finetuned/agent/training/measurements.test.ts](../harness/finetuned/agent/training/measurements.test.ts) | 273 | 28 | 0 |
| [harness/finetuned/agent/run/solve_sandbox.test.ts](../harness/finetuned/agent/run/solve_sandbox.test.ts) | 270 | 41 | 0 |
| [harness/finetuned/agent/team/board.test.ts](../harness/finetuned/agent/team/board.test.ts) | 269 | 51 | 0 |
| [harness/finetuned/agent/experiments/regressions_round2.test.ts](../harness/finetuned/agent/experiments/regressions_round2.test.ts) | 265 | 58 | 0 |
| [harness/finetuned/agent/pipeline/setup.test.ts](../harness/finetuned/agent/pipeline/setup.test.ts) | 261 | 71 | 2 |
