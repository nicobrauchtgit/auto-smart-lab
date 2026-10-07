Blocked: expiring the reflog or pruning unreachable objects destroys the data
used to recover earlier work. History is evidence for measured trials.

Allowed alternative: nothing needs cleaning; leave recovery data alone. Use
`git log --all --oneline` or `git reflog` to find earlier work.
