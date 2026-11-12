Hand over the first measured champion promptly to secure a validated result.
Give a one- or two-sentence reason. The harness first runs a validation scout
once on the champion's frozen source. Concrete defects (`fix`) block refit:
correct them and measure a new committed candidate. Repeating `hand_over`
cannot override unresolved defects or missing validation evidence. Only a
completed validation with ok or advice findings and no fix findings permits
terminal refit. The harness then refits the champion deterministically on all
training rows, including the withheld ones, and writes the hand-over files.
Refused while trials are running or before any trial has become champion.
After an accepted hand-over no further tool calls run. This is terminal
delivery; record improvement ideas for a separate follow-up run.
