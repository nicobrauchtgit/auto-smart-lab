Validate the current measured champion. Supply `reason` (1–1000 characters).
Default `finalize=false` records a nonterminal readiness checkpoint; set
`finalize=true` to request terminal delivery. Completed validation receipts are
reused for the same source and checks. Running trials block the request;
defects or missing evidence return validation feedback.
