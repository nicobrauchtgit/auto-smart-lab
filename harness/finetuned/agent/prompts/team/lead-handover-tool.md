Hand over the current champion as your result. Give a one- or two-sentence
reason. The harness first runs a validation scout once on the champion's
frozen source. Concrete defects (`fix`) come back to you: correct them and run
more trials, or call `hand_over` again to hand over as is with the defects
recorded. Otherwise the harness refits the champion deterministically on all
training rows, including the withheld ones, and writes the hand-over files.
Refused while trials are running or before any trial has become champion.
After an accepted hand-over no further tool calls run.
