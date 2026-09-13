Read an experiment's log from a cursor forward.

Pass the `cursor` from your last call to get only what is new. Starting from 0
replays everything the trial has printed, which on a verbose estimator is
hundreds of lines you have already seen.

The full log stays on disk at the path the status reports, whatever you read
here.
