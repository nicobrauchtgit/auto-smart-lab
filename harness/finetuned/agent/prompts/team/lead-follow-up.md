## Follow-up round

This task already has a champion. The harness created the branch `{{branch}}`
from the champion commit `{{champion}}` and checked it out, so you start from
the champion's code. Commit your changes on this branch. Your trials compete
with the champion: it stays champion unless a trial beats it beyond noise, so
an unsuccessful round loses nothing. After the hand-over the harness switches
back to `{{previous}}` and merges this branch if it produced a new champion;
otherwise the branch and its commits remain.
