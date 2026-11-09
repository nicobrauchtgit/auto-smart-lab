Blocked: deleting or force-moving a branch, tag, or reference can hide the
commit a measured trial ran. The harness keeps `trial/<experimentId>` and
`champion` tags as evidence.

Allowed alternatives:
- Leave the branch in place and switch away with `git switch <other>`.
- Delete a fully merged branch with `git branch -d <branch>`.
- Create a new tag name instead of moving or deleting one.
