---
name: scout-validation
description: Consult the validation scout to check a measured trial's frozen source for concrete defects before building on it.
---

# Validation scout

The validation scout checks one measured trial's frozen pipeline package and
available read-only records/inputs, plus the supplied question and findings.
It cannot see live pipeline code or withheld training rows/labels. It writes
only task checks; `run_checks` executes Python checks against that snapshot in
fresh processes. Bash is for reading files. It does not construct or tune models.

Advice: consult on a newly measured or promoted trial before building on it,
or when you have a concrete concern about leakage, fold-local fitting, output
format/domain, or inappropriate inputs. Ask several narrow questions as needed;
consultations are asynchronous. Do not treat an unverified risk as a defect.
Training labels delivered in archive member names are not themselves a defect.

Use `scout` with `role: "validation"`, a focused `question`, and `refs`.
Exactly one measured experiment must be identified with `{experiment: "trial-id"}`
or a `{check: "checks/spam1/check.py", experiment: "trial-id", sha256: "hash"}`
reference. Example: "Is vocabulary fitting confined to each training fold?"
Add `{file: "tasks/spam1.py", line: 12, commit: "commit-sha"}` or
`{entry: "finding-id"}` for the specific concern. Use actual IDs and hashes.

The request returns immediately. Final bullets arrive as news: `ok:` for what
was checked and correct, `fix:` for a demonstrated defect, `advice:` for risks
or improvements without a demonstrated defect. Files/lines and check paths
support the bullets; private transcripts do not return. Failures, stopped and
empty sessions are reported too.

Each explicit request costs one lead tool call. Validation through `hand_over`
is free for the lead. Each invocation retains its own fresh configured allowance
(currently 10 calls); those calls do not consume the lead's allowance. Roles
share the configured concurrency cap (currently 3); excess roles queue FIFO.
