# Uncommitted work from the old VM clone

Copied on 2026-10-07 from `~/auto-smart-lab` on the SmartLab VM (`stud02`),
which sat at commit `1fd1af5` (generation 1) with this work uncommitted:

- `agent/smartlab/tasks/spam2.py`, `agent/smartlab/tasks/spam3.py`: hand-written
  Multinomial Naive Bayes solvers in the removed `agent/smartlab/` layout.
- `agent/data_exploration_spam2.py`: a data exploration script for spam2.
- `smartlab_agent.py.patch`: the uncommitted change to the removed
  `agent/smartlab_agent.py` (registers the new tasks).

The old task IDs differ from today's: the old `spam3` was "Spam Detection with
Machine Learning", which is today's `spam1`.

Not committed, because it is course material or contains credentials and run
data: the old unit prompts and unit intros (they include the confidential unit
information) are in `units/_vm-archive/`, the old submissions and
`memory.json` in `runs/vm-archive/`. Both locations are gitignored.
