# Generated source inventory

Regenerate from the repository root: `./dev bun scripts/code-inventory.ts`.
Check freshness: `./dev bun scripts/code-inventory.ts --check`. Category fixtures: `./dev bun scripts/code-inventory.ts --self-test`.

Source snapshot SHA-256: `410325a9d299744c43b47369daf2799ba7cec3e85afb711a8c1f34500a8e86b5`.
Generator SHA-256: `f94d84237717b5c47d5ea88941d68c2247e25ec907cb4f92c5bf19998bb61be3`.
Parser: TypeScript 7.0.2; Python 3.13.15.

## Scope and interpretation

Only git-tracked TS/JS (including JSX, TSX, m/c variants) and Python under harness/, experiment/, scripts/, plus docs/redesign-*-reference.py are read. Working-tree bytes, including staged edits, are measured; add new sources to the index before regenerating. Other root code, Markdown, JSON, shell and lockfiles are outside the metrics. Excluded: node_modules, vendor, generated, dist, build, coverage, runs, units, .tools, .venv, fixtures, __fixtures__, declaration .d.ts/.d.mts/.d.cts and .generated. files. Fixtures are excluded rather than assigned to production. Historical/legacy tracked source remains included. No run data, secrets or model APIs are read.

Physical lines count LF-delimited lines, including comments and blank lines; a trailing LF does not add a line, empty files count zero. CRLF counts once. TS/JS counts body-bearing function declarations, expressions, arrows, methods, constructors and get/set accessors, recursively including anonymous callbacks and nested functions. Signatures/overloads without bodies and function types are excluded; a default constructor is not invented. Python ast counts def, async def and lambda recursively, including methods and nested definitions. Classes count declarations/expressions in TS/JS and ClassDef in Python. Counts describe syntax, not unique behavior, complexity or quality.

Test/support means tests/ or __tests__/ paths, test_*.py, *.test.* or *.spec.*, and testing.* or fixture-live.* helpers. All other included source is labelled production/tooling, including development scripts and hand-made references; this heuristic is not a runtime-reachability claim. Module groups are arm agent subdirectory (loose files: entrypoints) or top-level source directory.

The source digest hashes sorted path + NUL + byte length + NUL + bytes + NUL per included file. The report itself and commit IDs are excluded: committing a report cannot invalidate it. Generator identity is also recorded separately. There are no timestamps or machine paths in the output; identical inputs and parser versions produce identical output.

## Totals by arm, language and role

| Arm | Language | Role | Files | Lines | Callables | Classes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| finetuned | Python | production/tooling | 44 | 6598 | 302 | 21 |
| finetuned | Python | test/support | 15 | 2377 | 211 | 29 |
| finetuned | TypeScript | production/tooling | 99 | 14361 | 1309 | 19 |
| finetuned | TypeScript | test/support | 72 | 8360 | 1437 | 4 |
| minimal | Python | production/tooling | 11 | 2036 | 96 | 8 |
| minimal | TypeScript | production/tooling | 21 | 4569 | 327 | 3 |
| shared/development | Python | production/tooling | 3 | 89 | 1 | 0 |
| shared/development | TypeScript | production/tooling | 4 | 514 | 64 | 0 |
| shared/development | TypeScript | test/support | 2 | 238 | 40 | 0 |

**All included source:** 271 files; 39142 physical lines; 3787 callables; 84 classes.

## Module and language totals (both roles)

| Arm | Module | Language | Files | Lines | Callables | Classes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| finetuned | agent/confirmation | TypeScript | 4 | 379 | 58 | 0 |
| finetuned | agent/context | TypeScript | 2 | 538 | 103 | 1 |
| finetuned | agent/dryrun | TypeScript | 1 | 120 | 8 | 0 |
| finetuned | agent/entrypoints | TypeScript | 9 | 562 | 35 | 0 |
| finetuned | agent/experiments | TypeScript | 11 | 1658 | 202 | 2 |
| finetuned | agent/harness | TypeScript | 2 | 138 | 18 | 0 |
| finetuned | agent/libs | Python | 2 | 164 | 6 | 0 |
| finetuned | agent/pipeline | TypeScript | 24 | 3053 | 409 | 5 |
| finetuned | agent/prompts | TypeScript | 6 | 356 | 44 | 0 |
| finetuned | agent/refit | Python | 3 | 355 | 14 | 0 |
| finetuned | agent/refit | TypeScript | 7 | 810 | 99 | 0 |
| finetuned | agent/research | Python | 2 | 317 | 20 | 1 |
| finetuned | agent/research | TypeScript | 8 | 717 | 71 | 1 |
| finetuned | agent/run | TypeScript | 17 | 2177 | 272 | 1 |
| finetuned | agent/setup | Python | 4 | 1233 | 77 | 8 |
| finetuned | agent/setup | TypeScript | 7 | 1194 | 138 | 1 |
| finetuned | agent/solve | TypeScript | 5 | 565 | 90 | 0 |
| finetuned | agent/subagents | TypeScript | 10 | 1223 | 178 | 1 |
| finetuned | agent/submission | Python | 2 | 208 | 6 | 0 |
| finetuned | agent/submission | TypeScript | 8 | 591 | 133 | 1 |
| finetuned | agent/telemetry | TypeScript | 10 | 918 | 158 | 6 |
| finetuned | agent/tools | TypeScript | 3 | 1139 | 72 | 1 |
| finetuned | agent/training | Python | 41 | 6284 | 361 | 38 |
| finetuned | agent/training | TypeScript | 37 | 6583 | 658 | 3 |
| finetuned | docs | Python | 5 | 414 | 29 | 3 |
| minimal | agent/entrypoints | Python | 1 | 94 | 3 | 0 |
| minimal | agent/run | TypeScript | 17 | 3144 | 237 | 2 |
| minimal | agent/setup | Python | 7 | 1843 | 85 | 7 |
| minimal | agent/smartlab | Python | 3 | 99 | 8 | 1 |
| minimal | agent/tools | TypeScript | 4 | 1425 | 90 | 1 |
| shared/development | docs | Python | 3 | 89 | 1 | 0 |
| shared/development | experiment | TypeScript | 5 | 654 | 81 | 0 |
| shared/development | scripts | TypeScript | 1 | 98 | 23 | 0 |

## Longest production/tooling files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/training/service.ts](../harness/finetuned/agent/training/service.ts) | 1026 | 73 | 1 |
| [harness/minimal/agent/tools/smartlab.ts](../harness/minimal/agent/tools/smartlab.ts) | 819 | 52 | 1 |
| [harness/finetuned/agent/tools/smartlab.ts](../harness/finetuned/agent/tools/smartlab.ts) | 807 | 52 | 1 |
| [harness/finetuned/agent/training/python/smartlab_trial/search.py](../harness/finetuned/agent/training/python/smartlab_trial/search.py) | 713 | 44 | 3 |
| [harness/finetuned/agent/training/contract.ts](../harness/finetuned/agent/training/contract.ts) | 699 | 41 | 2 |
| [harness/minimal/agent/run/orchestrate.ts](../harness/minimal/agent/run/orchestrate.ts) | 639 | 29 | 1 |
| [harness/finetuned/agent/training/results.ts](../harness/finetuned/agent/training/results.ts) | 596 | 45 | 0 |
| [harness/minimal/agent/run/session_runner.ts](../harness/minimal/agent/run/session_runner.ts) | 562 | 35 | 0 |
| [harness/minimal/agent/setup/submit.py](../harness/minimal/agent/setup/submit.py) | 498 | 17 | 3 |
| [harness/minimal/agent/run/submit_session.ts](../harness/minimal/agent/run/submit_session.ts) | 491 | 54 | 1 |
| [harness/finetuned/agent/setup/fetch_unit.ts](../harness/finetuned/agent/setup/fetch_unit.ts) | 462 | 56 | 0 |
| [harness/finetuned/agent/run/harness_solve_session.ts](../harness/finetuned/agent/run/harness_solve_session.ts) | 425 | 28 | 0 |
| [harness/finetuned/agent/experiments/supervisor.ts](../harness/finetuned/agent/experiments/supervisor.ts) | 416 | 35 | 1 |
| [harness/finetuned/agent/pipeline/executor.ts](../harness/finetuned/agent/pipeline/executor.ts) | 410 | 19 | 0 |
| [harness/finetuned/agent/setup/python_environment.py](../harness/finetuned/agent/setup/python_environment.py) | 403 | 25 | 1 |
| [harness/minimal/agent/setup/fetch_units.py](../harness/minimal/agent/setup/fetch_units.py) | 400 | 25 | 0 |
| [harness/finetuned/agent/training/python/worker.py](../harness/finetuned/agent/training/python/worker.py) | 394 | 10 | 0 |
| [harness/finetuned/agent/telemetry/runtime.ts](../harness/finetuned/agent/telemetry/runtime.ts) | 375 | 43 | 2 |
| [harness/minimal/agent/setup/fetch_lab.py](../harness/minimal/agent/setup/fetch_lab.py) | 373 | 21 | 3 |
| [harness/finetuned/agent/setup/fetch_lab.py](../harness/finetuned/agent/setup/fetch_lab.py) | 323 | 19 | 3 |

## Longest test/support files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/setup/tests/test_python_environment.py](../harness/finetuned/agent/setup/tests/test_python_environment.py) | 320 | 25 | 3 |
| [harness/finetuned/agent/context/session.test.ts](../harness/finetuned/agent/context/session.test.ts) | 304 | 81 | 0 |
| [harness/finetuned/agent/training/python/test_worker.py](../harness/finetuned/agent/training/python/test_worker.py) | 287 | 16 | 1 |
| [harness/finetuned/agent/experiments/supervisor.test.ts](../harness/finetuned/agent/experiments/supervisor.test.ts) | 286 | 59 | 0 |
| [harness/finetuned/agent/pipeline/run_pipeline.test.ts](../harness/finetuned/agent/pipeline/run_pipeline.test.ts) | 282 | 52 | 0 |
| [harness/finetuned/agent/training/measurements.test.ts](../harness/finetuned/agent/training/measurements.test.ts) | 273 | 28 | 0 |
| [harness/finetuned/agent/training/results.test.ts](../harness/finetuned/agent/training/results.test.ts) | 269 | 34 | 0 |
| [harness/finetuned/agent/training/contract.test.ts](../harness/finetuned/agent/training/contract.test.ts) | 234 | 56 | 0 |
| [harness/finetuned/agent/training/python/test_measurements.py](../harness/finetuned/agent/training/python/test_measurements.py) | 234 | 18 | 2 |
| [harness/finetuned/agent/pipeline/setup.test.ts](../harness/finetuned/agent/pipeline/setup.test.ts) | 231 | 61 | 2 |
| [harness/finetuned/agent/training/recovery.test.ts](../harness/finetuned/agent/training/recovery.test.ts) | 231 | 49 | 0 |
| [harness/finetuned/agent/pipeline/executor.test.ts](../harness/finetuned/agent/pipeline/executor.test.ts) | 220 | 33 | 0 |
| [harness/finetuned/agent/telemetry/runtime.test.ts](../harness/finetuned/agent/telemetry/runtime.test.ts) | 210 | 54 | 0 |
| [harness/finetuned/agent/refit/service.test.ts](../harness/finetuned/agent/refit/service.test.ts) | 204 | 35 | 0 |
| [harness/finetuned/agent/subagents/pi.test.ts](../harness/finetuned/agent/subagents/pi.test.ts) | 204 | 34 | 0 |
| [harness/finetuned/agent/subagents/manager.test.ts](../harness/finetuned/agent/subagents/manager.test.ts) | 196 | 38 | 0 |
| [harness/finetuned/agent/run/harness_solve_session.test.ts](../harness/finetuned/agent/run/harness_solve_session.test.ts) | 183 | 40 | 0 |
| [harness/finetuned/agent/training/git.test.ts](../harness/finetuned/agent/training/git.test.ts) | 183 | 22 | 0 |
| [experiment/minimal.test.ts](../experiment/minimal.test.ts) | 182 | 32 | 0 |
| [harness/finetuned/agent/experiments/updates.test.ts](../harness/finetuned/agent/experiments/updates.test.ts) | 177 | 28 | 0 |
