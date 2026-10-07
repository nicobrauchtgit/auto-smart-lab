# Deterministic submission

`submitStage` in `agent/pipeline/stages/submit.ts` is a deterministic participant
in the shared executor. Configuration enables capability; it does not authorize
uploads. No evaluation verdict grants permission, and no model session runs here.

The controller supplies `StageInput.submissionPolicy`:

```ts
{ version: 1, authorized: boolean, maxSubmissions: number,
  pipelineRunId: string, controllerInvocationId: string }
```

`controllerInvocationId` is the durable accepted submit action/stage invocation ID.
It differs for successive submission actions and survives recovery of an action.
The policy is controller data, never a model tool argument or stage option.
`maxSubmissions` is an integer from zero through three. The controller persists
and validates immutable authorization and the requested goal of official score 1.
It chooses improvement work after the first two tries and the strongest validated
candidate for the last try. This transport returns evidence; it does not make
those decisions or authorize reuse of a terminal candidate's sealed rows for CV.

Execution requires exactly one checksummed `terminal_refit_result` upstream
artifact. It validates the result against its immutable freeze and terminal
marker, candidate identity, source commit/tree and clean frozen worktree, exact
input/data/evidence/dependency/framework hashes, seed lineage, row coverage,
prediction domain, and the harness's read-only refit validator. It does not fit.
Current task docs establish headerless semicolon-separated binary classification
output. Other task formats fail closed until an explicit adapter is implemented.
The authoritative refit CSV remains unchanged.

`bundle.py` reads committed blobs from the frozen worktree and allowlists Python
source. It excludes data, credentials, knowledge, transcripts and hidden files,
rejects symlinks/submodules and common embedded credential assignments, and
requires the selected entrypoint to appear. The ZIP contains `source/<relative
path>`, not the repository, task data, model pickle or run logs. Manifest hashes
bind exact packaged files, refit and freeze; CSV and ZIP must each fit 2 MiB.
This is a bounded source packaging check, not a general secret detection promise.

## Public API

`agent/submission/index.ts` exports:

- `readOfficialStatus(config: TransportConfig, signal?): Promise<OfficialStatus>`:
  Read-only task access (bounded authentication plus GET); includes official attempts, their states/scores, official used and
  remaining counts, and upload availability. CSRF tokens and response bodies are
  not returned.
- `submitRefit(options: SubmitRefitOptions): Promise<SubmissionResult>`:
  builds validated artifacts, reserves a durable intent, makes at most one upload
  POST for that action/bundle, and polls GET status within configured bounds.
- `readSubmissionAccounting(options: ReadSubmissionAccountingOptions): Promise<SubmissionAccounting>`:
  merges official status with task-global accounting for every new run and resume.
  It returns `officialStatus`, `reservedUnknown`, `effectiveTriesUsed`, and `unresolved`, reconciles
  existing intents under the accounting lock, and never builds or uploads a bundle.
  Original development artifacts are not required. Unknown or pending outcomes
  must block decision-agent execution even when a fresh run has no local work.
- `reconcileSubmission(options: ReconcileSubmissionOptions): Promise<SubmissionResult | null>`:
  Read-only task access, reconciles the stored action, writes a validated receipt and returns
  `null` if it has no local intent. It never builds source or makes an upload POST. Source/data availability is not needed for recovery;
  the durable bundle must still pass its hashes.
- `submissionRecoverySetupChecks({ taskId, policy?, projectRoot? }): SetupCheck[]`:
  status and credentials/accounting probes for executor reconciliation mode; pending
  attempts and exhausted budgets are allowed and no candidate files are required.
- `submissionSetupChecks({ taskId, policy?, projectRoot?, candidateProducedUpstream? }): SetupCheck[]`:
  shared preflight hook. Missing policy or explicit unauthorized policy skips
  credential/service checks. Malformed supplied policy fails. Standalone checks
  require existing refit evidence; upstream chains defer this check until stage
  execution. Checks do not create accounting directories.

Read-only task access may authenticate through the platform's bounded CSRF login
form using existing `LAB_USER` and `LAB_PASS`. This non-destructive authentication
POST is distinct from submission endpoint POSTs, which status/recovery never make.
`TransportConfig.cookie` and `LAB_SESSION_COOKIE` are optional session reuse, not
new prerequisites. No cookies, credentials or request headers enter artifacts or
observability. A configured trusted `LAB_CA_BUNDLE` supports private certificates;
TLS verification is never disabled. Nothing runs against the real service in
this module's tests. Disabled authorization returns before any HTTP request.

Results have version 1 and state `disabled`, `unknown`, `pending`, `rejected`, or
`scored`, with `officialScore`, `triesUsed`, `triesRemaining`, `reservedUnknown`,
`effectiveTriesUsed`, `newAttempt`, `attemptId`, `bundleId`, and `artifacts`.
Official scores must be finite in [0,1]; zero is a real score. `triesUsed` is the
official platform count; `effectiveTriesUsed` additionally reserves unmatched
local intents. `newAttempt` means this invocation issued a new durable intent,
not proof the server accepted a POST. Receipt and bundle artifacts have kinds
`submission_receipt` and `submission_bundle` and checksummed paths.

## Durable accounting and recovery

Accounting lives at `runs/submissions/<account/task-url scope>/ledger.json`,
outside individual pipeline runs. Scope uses account name and canonical task URL;
password rotation, new runs and restarts do not reset it. A kernel writer lock
covers status, reservation, POST and reconciliation. Bundle files and intent are
flushed before upload. Keep the ledger and bundles; never reset them to recover.

The official used count has a durable high-water mark. Historical rejected rows
may exist without consuming an official try; row count is not the usage count.
Unknown intents reserve a try, and pending/unknown local or pending remote
attempts block further uploads. A format failure releases or consumes a try only
according to official accounting. External submissions reduce the available
budget, including a fresh GET after bundle preparation. The remote platform must
still enforce its budget against external concurrent writers.

A random intent token is sent as the upload comment. Reconciliation requires
exactly one row with that token and an ID absent from the recorded baseline.
Duplicate matches, changed official identities or decreasing official usage block
uploads. If the platform overwrites or omits the token, the intent stays unknown;
there is no heuristic matching or automatic retry. No exactly-once guarantee is
claimed without server support. Even an HTTP rejection can have consumed a try;
only official status proves the outcome. Crashes before/after upload leave the
intent reserved. Recovery uses `reconcileSubmission` before making decisions.

Repeating an action ID with the same bundle returns its receipt without uploading;
reusing it for a different bundle fails. A repeated bundle under a different
accepted action is also not uploaded twice. `submitRefit` can reconcile a repeated
action but still validates/rebuilds its candidate; use the recovery API when the
source is no longer available.

The coordinator owns shared registry/types/config/CLI/setup integration and
standalone execution through the shared executor. Forward `candidateProducedUpstream`
to this preflight hook and include all enabled future capabilities before agents.
The stage implements `reconcile` through the same executor lifecycle and declares
`submission-recovery` as its recovery setup requirement. Null recovery results fail
closed without launching a new submission.

Stage options accept timing settings only: `timeoutMs`, `pollTimeoutMs`,
`pollIntervalMs` (positive integers at most 60,000). No transport option authorizes
submission. The stage declares `task`, `python`, `submission` setup requirements,
reports typed policy/refit inputs and submission events under its shared reporter,
and returns artifact validation for executor-owned lifecycle.

Mock suite: `./dev bun test agent/submission`. Uses the existing project
environment; no dependency installation or remote calls.
