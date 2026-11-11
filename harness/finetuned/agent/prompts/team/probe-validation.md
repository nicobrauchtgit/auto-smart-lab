Check the referenced trial alone: is anything in its frozen pipeline a defect
that makes its measurement or its test predictions wrong? Checks run through
`run_checks` may fit and predict with the snapshot's pipeline on development
data. Never execute corpus members themselves: for code tasks they are
untrusted programs, read them as bytes/text only.
