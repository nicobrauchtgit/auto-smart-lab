Blocked: `git reset --hard` and `git reset --keep` move a branch and can discard
commits. History is evidence for measured trials: every trial records the
commit it ran.

Allowed alternatives:
- Undo a committed change with `git revert <commit>`.
- Discard uncommitted edits to a file with `git restore <file>`.
- Continue from an older version on a new branch with
  `git switch -c <name> <commit>`.
