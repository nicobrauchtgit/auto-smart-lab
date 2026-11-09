# Open questions about the minimal arm

Leo built the minimal arm (`arms/minimal/`, history kept from `origin/main`). While merging
it next to the harness we had to guess at a few things. Each item says what we assumed, so
an answer can be checked against the current setup. Started 2026-11-09.

## Environment

1. **The lab VM's `~/env`.** `EXPERIMENT_LOG.md` (2026-10-03) records "Python 3.13.5, 198
   packages", and 2026-09-28 names numpy, scipy, scikit-learn, pandas, torch, tensorflow.
   We kept only the named stack, without TensorFlow (`arms/minimal/requirements.in`), pinned
   to the harness's versions. Do you have the full list or any versions? Did a solver ever
   import TensorFlow or Keras? The CIFAR-10 run (log, attacks unit) downloaded data via Keras.
2. **Plain `pip`.** We assumed the solver may install packages into its own venv, as on the
   VM. Was that allowed in every measured run?

## Model

3. **Provider entry.** Your README documents `contextWindow` 262,144, `maxTokens` 32,768,
   `reasoning: true` and `compat` (`supportsDeveloperRole: false`,
   `supportsReasoningEffort: false`). The merged arm uses exactly that. Is it what
   `~/.pi/agent/models.json` held in your runs?
4. **Why `compat`?** With reasoning on, pi otherwise sends the system prompt with the
   `developer` role and a `reasoning_effort` parameter. A harness session without `compat`
   worked on 2026-11-09. Did requests fail for you without it, or was it a precaution?

## Protocol

5. **Budgets.** 30-minute sessions and 3 failed sessions per task: chosen for the GWDG quota,
   or part of what "minimal" means?
6. **`--reset once`.** Later tasks in a batch may reuse earlier solvers and memory. Is that
   intended for measured runs, or should every task start empty?
7. **Langfuse.** Is the arm's Langfuse tracing needed for the experiment, or only for debugging?

## Tasks and scores

8. **Task prompts.** `units/_vm-archive/` holds the old prompts and metadata for 15 tasks. Are
   they the final versions the instructor uses with the shared-drive datasets?
9. **Token tasks.** defense1 and offense1–2 needed the lab VM. Is there an offline way to
   score them?
10. **Instructor scores.** `docs/instructor_scores.json` is empty. Did any offline delivery get
    a score back?
