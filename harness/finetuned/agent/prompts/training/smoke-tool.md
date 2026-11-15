Import and build a committed pipeline, fit a class-balanced sample of a few
hundred development rows and validate predictions and row IDs. Send the same
request object as experiment_start. A failure states the step, the sample size
and the traceback; if a larger sample runs, the failure is reported as caused by
the sample size and smoke passes. workspace_check findings are reported
alongside; only unsafe source paths block. This check charges no trial and
supplies no promotion evidence.
