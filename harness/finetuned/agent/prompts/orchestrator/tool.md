Narrow durable pipeline control. Use trusted artifact/invocation IDs returned by controller status. Mutation actionId deduplicates the identical logical request; expectedRevision rejects stale or concurrent decisions. Rationale records the decision and evidence, not authorization. Wait for significant terminal evidence with pipeline_wait; acknowledge its cursor on the next wait. Bounded artifact details contain validated provenance; worker/model assertions remain separate from measurements. Finish only after owned work settles. Submission policy and options come from the controller, never tool arguments.

Anomaly tasks may explicitly configure scoring-only selection as
`selection:{basis:"evidence",metric:"evidence_average_precision",direction:"maximize",population:"development"}`
(or evidence_roc_auc). Official metric remains none. The solve agent supplies
partial explicit 0/1 labels for existing development IDs; both classes are
required per fold. Promotion still requires complete paired evidence beyond
noise. No automatic proxy fallback, generated challenge population or verified
attack/label correctness is implied. Evaluation reports coverage and provenance.
