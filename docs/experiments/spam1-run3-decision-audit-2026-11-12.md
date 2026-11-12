# Spam1 run 3: decision-loop audit

Read-only audit completed 2026-11-12 after the user's authorization to finish
observing the existing run and report concrete failures. No new model run,
solution edits, prompt intervention, upload or restart was performed by this
audit. This is one observed run, not evidence of cross-task reliability.

## Identity and terminal outcome

- Pipeline: `33b69aad-d358-42d9-b4d3-398bf561b40d`.
- Lead/training invocation: `fdd3c27d-9131-4b29-8176-ea0ccb944dbb`.
- Langfuse trace: `96b0f9f5335547a69bab654b0cf49e06`.
- Launch log begins at 14:49:08.856 UTC; lead starts at 14:49:59.764.
- External SIGINT was recorded at 15:49:14. Langfuse records session
  cancellation at 15:49:16.312 and `lead_run_finished` with
  `stop_reason: cancelled` at 15:49:16.834. This was cancellation, not natural
  completion or tool-budget exhaustion.
- Final persisted budget: 71/80 calls; two explicit scout requests.
- Baseline readiness validation completed at 15:17:13.951: 27m14s after
  lead start, about 28m05s after launch. Phase changed to improvement.
- Baseline remained champion: CV balanced accuracy 0.9938588638927701.
- No terminal hand-over or new accepted delivery is established. Archived
  PROGRESS still says `running`; the cancellation events and supervisor receipts
  supersede that stale lifecycle field. Do not interpret it as an active run.

Evidence root:
`runs/archives/2026-11-12T15-49-24Z-spam1-run3-async-scouts/`.
The run had already been archived when this audit started; it was not moved or
reset by the audit. Existing deliveries elsewhere are not attributed to it.

## Observable decisions

1. **Initial investigation.** A combined data/ideas request started at
   14:51:47.015 and finished at 15:02:06.220. It produced 9 data and 13 ideas
   findings. The lead built a word/character TF-IDF plus metadata baseline.
   First trial started at 15:05:03.647 and finished at 15:08:29.618. Thus an
   asynchronous scout interface did not itself ensure an early trial: this
   trial began after the initial consultation completed.
2. **Early verification.** `hand_over` was called at 15:10:04.572 as a
   nonterminal checkpoint; validation produced 10 findings. The baseline was
   retained and the goal changed to improvement. This is observed working
   baseline protection, not merely an available tool.
3. **Model search.** At 15:21:15.199 the lead requested up to nine TPE
   configurations: logistic regression, linear SVM or NB-weighted SVM, with
   C between 0.5 and 20. After one configuration completed, the cost guard
   projected 4,900 seconds for the search, above its 900-second unacknowledged
   threshold, and stopped gracefully. At 15:30:45.618 the result was
   `interrupted`, `promotionEligible: false`. This is a cost-policy stop,
   not an estimator crash or a machine-risk stop.
4. **Focused follow-up.** At 15:24:36.183 the lead asked ideas about specific
   baseline errors: short legitimate messages, promotional-looking legitimate
   mail and missed spam templates. It asked about length-sensitive features,
   a subject channel, template similarity and decision thresholds, citing the
   baseline trial. The consultation finished at 15:27:20.504 with 11 findings.
5. **Advice became implementation.** Solution commit `46090db` at 15:36:45
   added length-normalized structural features and type-token ratio, optional
   subject TF-IDF and accent folding, and increased the SVM iteration limit.
   The lead then submitted a single SVM candidate at C=2.62 at 15:36:56.433,
   narrowing the earlier oversized search. The request describes the same
   text features, but the source also changes the metadata representation;
   it is not an isolated classifier-only comparison. Optional code does not
   establish that every optional feature was enabled or measured.
6. **Later comparison remained unfinished.** All five candidate folds ended
   by 15:44:50.759. The worker then refitted the immutable champion on the
   paired folds. Four champion folds completed by 15:49:03.570; cancellation
   stopped the worker before the full comparison/result was committed.
   There is no justified promotion or rejection conclusion for this candidate.

## Concrete failures and limits

### The external stopping policy contradicted runtime guidance

Actual model-request inputs at 14:50:40.359 and 14:50:55.285 contain:
“Wall time is recorded but not limited.” The run was nevertheless externally
cancelled around an hour. It is unsound to judge the lead as failing to plan a
terminal delivery for a deadline contradicted by its instructions. End-to-end
planning also needs to account for champion comparison, validation and refit,
not only the candidate's folds. Deadline-aware finalization is not demonstrated
by this run.

### The prompt-only ban on local candidate comparisons was violated

The supervised shell receipt `bash-38dfab01` at 15:32:32 contains a local loop
fitting/scoring five candidates on a 4,000-row development subset: base SVM,
subject channel, accent folding, metadata off and threshold calibration. Output
was piped through `tail`. This is model comparison outside the harness, despite
the lead prompt prohibiting local sweeps. It is not authoritative promotion
evidence. Supervision provides containment/resource accounting; it does not
prove compliance with the experimental policy.

### Candidate changes were not isolated

The follow-up trial combined classifier/regularization changes with an altered
metadata representation. That can test a composite hypothesis, but it cannot
attribute a change in performance to a particular scout suggestion. The run
therefore demonstrates targeted consultation and implementation, but not a
completed, interpretable feature-ablation cycle.

## Assessment and next work

The existing architecture demonstrated a meaningful feedback loop: measured
baseline, early validation, targeted research, incorporation of advice and
adaptation from an oversized search to a single candidate. It did not establish
convergence or an improved accepted solution. The final comparison was externally
interrupted, so describing it as a failed improvement would overstate the data.

Prioritize exposing the actual run deadline/reserve to the lead and controller,
and addressing local-comparison compliance, before adding orchestration layers
or optimizing task-specific prompts. Exact time reserves or enforcement designs
remain engineering decisions, not completed capabilities. Preserve the archived
baseline and unfinished comparison; this audit authorizes no rerun.

The known interruption causes were cost guarding and external cancellation;
no machine-risk stop was identified in the inspected receipts. Resource snapshots
were healthy, but this is not proof that every resource sample was audited.

Sources inspected: archived PROGRESS, findings journal, trial requests/results,
supervision command/exit/state receipts, trial event logs and solution Git
history; Langfuse scout/tool/cancellation events and captured model-request
inputs; original one-shot monitoring outputs. Private confirmation values and
withheld labels are deliberately omitted. No development test suite was run
for this documentation-only audit.
