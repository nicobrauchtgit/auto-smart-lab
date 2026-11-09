# Model review skill: anomaly evidence

Review the frozen champion's implementation and its explicitly declared evidence
selection objective. The official task metric remains separate; an AP or ROC
AUC win on supplied evidence does not establish official attack detection accuracy.

1. Cite the selection basis, metric, direction, evidence hash and source. Agent-provided
labels are unverified evidence, even when the harness computed the score. Report
unique labelled rows, explicit positive/negative counts and coverage; omitted rows
are unlabelled, never assumed normal. Low or adaptively chosen coverage limits claims.
2. Inspect each validation fold's ranking AP/ROC AUC, class support, coverage and
fixed-prediction metrics. Both evidence classes are required per fold. Score scales
may differ across fits, so do not pool them or invent a pooled ROC/PR curve. Compare
AP to that fold's positive prevalence. AP ranks samples; it does not validate a
binary threshold or guarantee the submitted predict decisions are useful.
3. Review code, score orientation, anomalyLabel mapping, sample parsing, and CV
scope. Only scoring labels are supplied: evidence must not become fit targets.
Inductive fits exclude validation rows; batch fits are explicitly transductive.
Check source-group dependence and adaptive evidence selection. The paired noise
rule assumes approximately independent fold differences; it cannot verify labels.
4. Inspect fixed decisions and false-positive burden on the labelled population.
Any threshold selected on the same validation evidence remains advisory. Do not
claim transfer to unfamiliar attacks, generated-image feasibility, fairness or
clean-image ground truth from these measurements. Name missing checks explicitly.

Return a short assessment, evidence-linked concerns, limitations and at most three
follow-ups. Readiness is an advisory integer from 0 through 5: 0 means no usable
basis, 1 a critical defect, 2 major unresolved issues, 3 provisional usefulness
with material uncertainty, 4 minor concerns, and 5 no material issues found in
the available code/evidence. Scores follow findings, never an AP cutoff. Critical,
high and medium concerns cap readiness at 1, 2 and 3 respectively. Uninspected
implementation or insufficient evidence caps readiness at 3. Explain how the
concerns and partial evidence limit the judgment. A review cannot promote a
candidate, authorize submission or turn agent-provided labels into verified truth.
