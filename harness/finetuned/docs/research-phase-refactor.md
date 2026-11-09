# Research phase refactor backlog

Status: deferred; discussion captured on 2026-09-01. Do not treat this file as
the current implementation contract.

Update, 2026-09-08: research now runs as the first stage of the shared executor
under the [pipeline integration and observability contract](pipeline-integration.md).
`npm run research`, `npm run solve -- --research[-only]`, and
`npm run pipeline -- unit 1 task 1` all go through that instrumented path.
The compact training-label startup profile is now an implemented exception to the
earlier proposal below to remove all controller-side analysis; deeper
investigation remains agent-owned.

## Direction

Keep the research phase modular and filesystem-based. The research agent should
read the task and dataset, perform focused internet research, create its own
reproducible analysis scripts and artifacts, and maintain a traceable
`research.md` for later solver stages. TypeScript should orchestrate that work,
not attempt to encode research judgment.

## Refactor items

- Remove fixed research limits (`web_search_calls`, report/artifact sizes, and
  feature-recommendation count) from `ResearchContext`. Infrastructure-level
  timeouts or API budgets may remain separate from research semantics.
- Replace repository-wide `findTask(taskId)` discovery with an explicit task
  argument supplied by the orchestrator. Include the task ID/title, task and
  prompt paths, data directory, and an existing data hash when available.
- Remove controller-side recursive dataset inventory via `walkFiles()`. Dataset
  inspection and the choice between complete aggregation and sampling belong to
  the research agent's analysis code.
- Remove the rigid `DatasetEvidenceRecord` schema and the assumption that
  evidence must be either `full` or `sampled`. The research output should state
  its actual coverage and method, which may include streaming aggregation,
  deterministic or stratified sampling, metadata inspection, or another
  appropriate strategy.
- Remove the special ban on legacy `[E###]` and `[M###]` references. What matters
  is that a claim points to an existing, traceable source—not its prefix.
- Reduce regex-heavy document validation. Keep only useful mechanical checks,
  such as a nonempty `research.md`, referenced local artifacts existing, writes
  staying inside the research workspace, and basic credential-leak detection.
  Treat headings, citation naming, recommendation counts, scope language, and
  revision formatting as model guidance rather than a TypeScript document
  parser.

## Intended interface

```ts
interface ResearchTask {
	id: string;
	title: string;
	unit: string;
	taskDir: string;
	promptPath: string;
	dataDir: string;
	dataHash?: string;
}

runResearchSession(task: ResearchTask, model?: string)
```

The CLI may resolve a conventional task directory for human use, while the
pipeline should pass the task object it already has.

## Acceptance criteria

- A research run can be invoked for a supplied task without scanning `units/`.
- The controller does not pre-analyze or recursively inventory the dataset.
- The agent chooses and documents an analysis strategy appropriate to dataset
  size.
- Internet sources and local analysis remain traceable from `research.md`.
- The living research document can be improved by later runs without a result
  cache or a rigid citation schema.
- The solver can consume the research output when the modular pipeline enables
  the research phase.
