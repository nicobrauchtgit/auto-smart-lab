# Generated source inventory

Regenerate from the repository root: `./dev bun scripts/code-inventory.ts`.
Check freshness: `./dev bun scripts/code-inventory.ts --check`. Category fixtures: `./dev bun scripts/code-inventory.ts --self-test`.

Source snapshot SHA-256: `796a364a55cbca661128173f9b718727630f38f35c0806d36947aa90f6d3c0c1`.
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
| finetuned | Python | production/tooling | 50 | 7720 | 344 | 23 |
| finetuned | Python | test/support | 17 | 2602 | 234 | 33 |
| finetuned | TypeScript | production/tooling | 130 | 18323 | 1946 | 24 |
| finetuned | TypeScript | test/support | 85 | 10774 | 1971 | 4 |
| minimal | Python | production/tooling | 11 | 2036 | 96 | 8 |
| minimal | TypeScript | production/tooling | 20 | 4518 | 324 | 3 |
| shared/development | Python | production/tooling | 3 | 89 | 1 | 0 |
| shared/development | TypeScript | production/tooling | 4 | 498 | 61 | 0 |
| shared/development | TypeScript | test/support | 2 | 212 | 35 | 0 |

**All included source:** 322 files; 46772 physical lines; 5012 callables; 95 classes.

## Module and language totals (both roles)

| Arm | Module | Language | Files | Lines | Callables | Classes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| finetuned | agent/confirmation | TypeScript | 4 | 398 | 63 | 0 |
| finetuned | agent/context | TypeScript | 2 | 541 | 103 | 1 |
| finetuned | agent/entrypoints | TypeScript | 13 | 747 | 46 | 0 |
| finetuned | agent/evaluation | Python | 2 | 361 | 21 | 2 |
| finetuned | agent/evaluation | TypeScript | 6 | 408 | 63 | 1 |
| finetuned | agent/experiments | TypeScript | 11 | 1658 | 202 | 2 |
| finetuned | agent/harness | TypeScript | 2 | 144 | 18 | 0 |
| finetuned | agent/knowledge | Python | 1 | 114 | 2 | 0 |
| finetuned | agent/knowledge | TypeScript | 9 | 1228 | 191 | 2 |
| finetuned | agent/libs | Python | 2 | 164 | 6 | 0 |
| finetuned | agent/orchestrator | TypeScript | 9 | 1697 | 485 | 2 |
| finetuned | agent/pipeline | TypeScript | 27 | 3458 | 447 | 5 |
| finetuned | agent/prompts | TypeScript | 7 | 469 | 58 | 0 |
| finetuned | agent/refit | Python | 3 | 355 | 14 | 0 |
| finetuned | agent/refit | TypeScript | 7 | 810 | 99 | 0 |
| finetuned | agent/research | Python | 2 | 340 | 22 | 1 |
| finetuned | agent/research | TypeScript | 11 | 1284 | 130 | 1 |
| finetuned | agent/run | TypeScript | 18 | 2547 | 287 | 1 |
| finetuned | agent/scorecard | TypeScript | 7 | 1259 | 264 | 0 |
| finetuned | agent/setup | Python | 4 | 1233 | 77 | 8 |
| finetuned | agent/setup | TypeScript | 7 | 1194 | 138 | 1 |
| finetuned | agent/solve | TypeScript | 6 | 648 | 95 | 0 |
| finetuned | agent/subagents | TypeScript | 10 | 1242 | 181 | 1 |
| finetuned | agent/submission | Python | 2 | 208 | 6 | 0 |
| finetuned | agent/submission | TypeScript | 8 | 591 | 133 | 1 |
| finetuned | agent/telemetry | TypeScript | 10 | 918 | 158 | 6 |
| finetuned | agent/tools | TypeScript | 3 | 1139 | 72 | 1 |
| finetuned | agent/training | Python | 43 | 6475 | 374 | 40 |
| finetuned | agent/training | TypeScript | 38 | 6717 | 684 | 3 |
| finetuned | docs | Python | 8 | 1072 | 56 | 5 |
| minimal | agent/entrypoints | Python | 1 | 94 | 3 | 0 |
| minimal | agent/run | TypeScript | 16 | 3095 | 234 | 2 |
| minimal | agent/setup | Python | 7 | 1843 | 85 | 7 |
| minimal | agent/smartlab | Python | 3 | 99 | 8 | 1 |
| minimal | agent/tools | TypeScript | 4 | 1423 | 90 | 1 |
| shared/development | docs | Python | 3 | 89 | 1 | 0 |
| shared/development | experiment | TypeScript | 5 | 612 | 73 | 0 |
| shared/development | scripts | TypeScript | 1 | 98 | 23 | 0 |

## Longest production/tooling files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/training/service.ts](../harness/finetuned/agent/training/service.ts) | 1029 | 72 | 1 |
| [harness/minimal/agent/tools/smartlab.ts](../harness/minimal/agent/tools/smartlab.ts) | 819 | 52 | 1 |
| [harness/finetuned/agent/tools/smartlab.ts](../harness/finetuned/agent/tools/smartlab.ts) | 807 | 52 | 1 |
| [harness/finetuned/agent/training/python/smartlab_trial/search.py](../harness/finetuned/agent/training/python/smartlab_trial/search.py) | 713 | 44 | 3 |
| [harness/finetuned/agent/training/contract.ts](../harness/finetuned/agent/training/contract.ts) | 699 | 41 | 2 |
| [harness/minimal/agent/run/orchestrate.ts](../harness/minimal/agent/run/orchestrate.ts) | 638 | 29 | 1 |
| [harness/finetuned/agent/training/results.ts](../harness/finetuned/agent/training/results.ts) | 600 | 46 | 0 |
| [harness/minimal/agent/run/session_runner.ts](../harness/minimal/agent/run/session_runner.ts) | 562 | 35 | 0 |
| [harness/minimal/agent/setup/submit.py](../harness/minimal/agent/setup/submit.py) | 498 | 17 | 3 |
| [harness/minimal/agent/run/submit_session.ts](../harness/minimal/agent/run/submit_session.ts) | 491 | 54 | 1 |
| [harness/finetuned/agent/orchestrator/coordinator.ts](../harness/finetuned/agent/orchestrator/coordinator.ts) | 487 | 158 | 1 |
| [harness/finetuned/agent/setup/fetch_unit.ts](../harness/finetuned/agent/setup/fetch_unit.ts) | 462 | 56 | 0 |
| [harness/finetuned/agent/run/harness_solve_session.ts](../harness/finetuned/agent/run/harness_solve_session.ts) | 433 | 26 | 0 |
| [harness/finetuned/agent/pipeline/executor.ts](../harness/finetuned/agent/pipeline/executor.ts) | 422 | 19 | 0 |
| [harness/finetuned/agent/experiments/supervisor.ts](../harness/finetuned/agent/experiments/supervisor.ts) | 416 | 35 | 1 |
| [harness/finetuned/agent/training/python/worker.py](../harness/finetuned/agent/training/python/worker.py) | 407 | 10 | 0 |
| [harness/finetuned/agent/setup/python_environment.py](../harness/finetuned/agent/setup/python_environment.py) | 403 | 25 | 1 |
| [harness/minimal/agent/setup/fetch_units.py](../harness/minimal/agent/setup/fetch_units.py) | 400 | 25 | 0 |
| [harness/finetuned/agent/telemetry/runtime.ts](../harness/finetuned/agent/telemetry/runtime.ts) | 375 | 43 | 2 |
| [harness/minimal/agent/setup/fetch_lab.py](../harness/minimal/agent/setup/fetch_lab.py) | 373 | 21 | 3 |

## Longest test/support files (top 20)

| Path | Lines | Callables | Classes |
| --- | ---: | ---: | ---: |
| [harness/finetuned/agent/orchestrator/coordinator.test.ts](../harness/finetuned/agent/orchestrator/coordinator.test.ts) | 582 | 192 | 0 |
| [harness/finetuned/agent/scorecard/scorecard.test.ts](../harness/finetuned/agent/scorecard/scorecard.test.ts) | 399 | 74 | 0 |
| [harness/finetuned/agent/training/results.test.ts](../harness/finetuned/agent/training/results.test.ts) | 329 | 43 | 0 |
| [harness/finetuned/agent/setup/tests/test_python_environment.py](../harness/finetuned/agent/setup/tests/test_python_environment.py) | 320 | 25 | 3 |
| [harness/finetuned/agent/context/session.test.ts](../harness/finetuned/agent/context/session.test.ts) | 307 | 81 | 0 |
| [harness/finetuned/agent/training/python/test_worker.py](../harness/finetuned/agent/training/python/test_worker.py) | 287 | 16 | 1 |
| [harness/finetuned/agent/experiments/supervisor.test.ts](../harness/finetuned/agent/experiments/supervisor.test.ts) | 286 | 59 | 0 |
| [harness/finetuned/agent/pipeline/run_pipeline.test.ts](../harness/finetuned/agent/pipeline/run_pipeline.test.ts) | 282 | 52 | 0 |
| [harness/finetuned/agent/training/measurements.test.ts](../harness/finetuned/agent/training/measurements.test.ts) | 273 | 28 | 0 |
| [harness/finetuned/agent/pipeline/setup.test.ts](../harness/finetuned/agent/pipeline/setup.test.ts) | 248 | 69 | 2 |
| [harness/finetuned/agent/training/contract.test.ts](../harness/finetuned/agent/training/contract.test.ts) | 234 | 56 | 0 |
| [harness/finetuned/agent/training/python/test_measurements.py](../harness/finetuned/agent/training/python/test_measurements.py) | 234 | 18 | 2 |
| [harness/finetuned/agent/training/recovery.test.ts](../harness/finetuned/agent/training/recovery.test.ts) | 231 | 49 | 0 |
| [harness/finetuned/agent/knowledge/knowledge.test.ts](../harness/finetuned/agent/knowledge/knowledge.test.ts) | 227 | 39 | 0 |
| [harness/finetuned/agent/pipeline/executor.test.ts](../harness/finetuned/agent/pipeline/executor.test.ts) | 220 | 33 | 0 |
| [harness/finetuned/agent/telemetry/runtime.test.ts](../harness/finetuned/agent/telemetry/runtime.test.ts) | 210 | 54 | 0 |
| [harness/finetuned/agent/refit/service.test.ts](../harness/finetuned/agent/refit/service.test.ts) | 204 | 35 | 0 |
| [harness/finetuned/agent/subagents/pi.test.ts](../harness/finetuned/agent/subagents/pi.test.ts) | 204 | 34 | 0 |
| [harness/finetuned/agent/orchestrator/budget_end.test.ts](../harness/finetuned/agent/orchestrator/budget_end.test.ts) | 200 | 56 | 0 |
| [harness/finetuned/agent/training/evidence_selection.test.ts](../harness/finetuned/agent/training/evidence_selection.test.ts) | 200 | 33 | 0 |
