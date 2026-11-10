# Code analysis for reviewers

[Review guide](review-guide.md) · [Architecture](architecture.md) · [Generated source inventory](code-inventory.md)

## How to read the metrics

The inventory is the numeric source of truth. It counts tracked working-tree source with TypeScript compiler ASTs and Python ast, not regular-expression guesses. It includes legacy code and development references, excludes generated/vendor/run/task data and fixtures, and separates tests/support from production/tooling. Definitions, line conventions, exact exclusions, parser versions and source/generator SHA-256 identities are in the report. Module totals are split by language; arm totals are split by language and role. No JavaScript files match the current scope; the parser supports them for future additions.

Regenerate after staging integrated source with `./dev bun scripts/code-inventory.ts`. Verify with `./dev bun scripts/code-inventory.ts --check` and `./dev bun scripts/code-inventory.ts --self-test`. The script uses the installed TypeScript 7 asynchronous compiler API (the package root exports version metadata, not the older parser API) over a closed virtual filesystem, plus the shared Python interpreter. No dependency was added. AST traversal counts anonymous and nested callables, so callback-heavy TypeScript tests can have many functions in few lines. Python lambdas and methods count too. These are syntax counts, not cyclomatic complexity, runtime reachability, coverage or maintainability scores.

At this documentation snapshot:

| Scope | Files | Physical lines | Callables | Classes |
| --- | ---: | ---: | ---: | ---: |
| Finetuned, both roles | 279 | 38,765 | 4,343 | 84 |
| Minimal, production/tooling | 31 | 6,554 | 420 | 11 |
| Shared/development, both roles | 8 | 675 | 85 | 0 |
| Total | 318 | 45,994 | 4,848 | 95 |

These totals describe this checkout based on 6901a54. The integration parent is now 83b2d47 with P3 current at fd96ccd; regenerate against that integrated source before publication. P1 eee1894 remains blocked and unintegrated. They are not a controlled comparison of implementation effort: the finetuned arm includes a much larger test suite, reusable libraries, historical prototypes and contract infrastructure. The minimal arm has no matching tracked tests inside its own folder; experiment boundary tests live in shared code. That does not establish that its behavior is untested, nor does the larger arm's test count establish correctness.

## Concentration and review hotspots

The [generated longest-file tables](code-inventory.md#longest-productiontooling-files-top-20) separate production/tooling from tests. At the parent baseline, the largest production file is [training/service.ts](../harness/finetuned/agent/training/service.ts): 1,029 lines, 72 callables. Its responsibilities span contract validation, ownership discovery, source/seed setup, launch, recovery, worker completion and close. Review it by lifecycle transitions and durable receipts, alongside its adjacent tests; splitting it is not part of this documentation task.

[training/contract.ts](../harness/finetuned/agent/training/contract.ts), [training/results.ts](../harness/finetuned/agent/training/results.ts) and [Python search.py](../harness/finetuned/agent/training/python/smartlab_trial/search.py) are the other high-consequence evidence components. The training module has 13,136 lines across production and tests at this baseline. The TypeScript/Python seam carries serialized trial, seed and result contracts; check both producer and consumer when changing schema or cost accounting. [Seed vectors](../harness/finetuned/agent/training/seed-vectors.json), [contract tests](../harness/finetuned/agent/training/contract.test.ts) and [worker tests](../harness/finetuned/agent/training/python/test_worker.py) provide concrete cross-language review evidence.

[orchestrator/coordinator.ts](../harness/finetuned/agent/orchestrator/coordinator.ts) has 136 callable nodes in 401 lines, reflecting methods and embedded callbacks rather than 136 distinct user features. Read its action acceptance, stage dispatch, artifact inspection and wait paths with [coordinator tests](../harness/finetuned/agent/orchestrator/coordinator.test.ts). Action receipt durability, budget reservations and physical-session lifecycle are coupled; P3 changed their semantics in fd96ccd and therefore requires whole-branch validation after this documentation lands. The [scorecard tests](../harness/finetuned/agent/scorecard/scorecard.test.ts) are the largest test file at this snapshot, but scorecard assertions cannot supply missing live run evidence.

## Duplication, legacy paths and coupling

The two large `agent/tools/smartlab.ts` files ([minimal](../harness/minimal/agent/tools/smartlab.ts), [finetuned](../harness/finetuned/agent/tools/smartlab.ts)) have similar command/API scaffolding and are 819 and 807 lines respectively. This is a qualitative source observation, not a computed clone percentage. The minimal and finetuned arms also retain separate setup/auth/submission helpers. Deduplicating across arms can create treatment contamination; first establish reachability, authorization and isolation. Historical cleanup notes flag interactive legacy tools that can bypass the finetuned submission ledger.

[experiment/minimal.ts](../experiment/minimal.ts) imports sandbox/environment support from the finetuned host code. That is a real host-side coupling, despite separate agent runtime visibility. Boundary tests should continue proving the copied minimal agent cannot see finetuned code or prompts. Independent runtime arms do not imply fully independent development dependencies.

The [stage registry](../harness/finetuned/agent/pipeline/registry.ts), [guidance](../harness/finetuned/agent/pipeline/guidance.ts), [feedback](../harness/finetuned/agent/pipeline/feedback.ts), [config defaults](../harness/finetuned/agent/pipeline/config.ts) and prompt registry all name current stages. A new role requires coordinated changes and setup declarations; merely adding a prompt does not implement an expert. The expert-team design's package ownership table documents these consumers. Current session/search environment includes process-global state, which P6 must resolve before parallel expert sessions.

[agent/subagents](../harness/finetuned/agent/subagents/README.md), legacy interactive runners and old instructions remain tracked and counted. Presence is not registration: the controller contract explicitly does not expose generic diagnostic delegation. Keep old instruction files unchanged until running-process and external-reference checks permit retirement. [agent/prompts](../harness/finetuned/agent/prompts/README.md) is the authored source for migrated module prompts.

## Design assessment and concrete follow-ups

The main architectural strength is an explicit authority boundary: agent choices are flexible while measured evidence, replay, promotion and terminal identity belong to the harness. Typed stage artifacts, whole-chain preflight and shared telemetry make a stage more reviewable than a successful chat transcript. The cost is a large coupled lifecycle across controller, worker, source snapshots, confirmation, refit and submission; local durability is not distributed consensus.

Review follow-ups, without broadening this change:

- Regenerate the inventory after parent integration with current P3. P1 remains unintegrated: eee1894 unconditionally blocks production pool setup/launch because strict victim ordering is unproven. A user policy decision is pending. Current sampler support is Darwin-only.
- Verify integrated P3 whole-branch behavior: interrupted charging, deadline hand-over and detached recovery. The 6901a54 inventory checkout reserves solve allocations and has percentage wakes; fd96ccd removes those behaviors and passed 61 focused tests per the parent update.
- Implement P6/P7 source-bound validation and task-persistent split declarations. Current live-source reviewer checks can disagree with frozen trial source.
- Verify clustering batch semantics and task adapters end to end. Current sealed confirmation skips non-binary tasks. P7c's label-free unscored/evidence-label hand-over is future work.
- Establish actual integrated spam1, code2 and attacks1 evidence before claiming redesign success. No live run was made for this documentation.
- Choose measured protocol, repetitions, ordering and carryover/reset policy explicitly. Historical model probes and exercise results do not decide these.

The [ADR index](adr/README.md) explains the intended balance of finite host RAM, agent flexibility, context-token limits and durable cross-task knowledge. Those concepts should not be collapsed into a single “memory budget.”
