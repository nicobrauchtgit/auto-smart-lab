The harness stopped this search gracefully. Completed configurations and their
fold results are kept and reported. To continue, choose one or more of:

- fewer configurations: lower `search.maxConfigs` (the facts list how many fit
  under the threshold);
- a pilot scope: `scope.maxRows` or `scope.maxFolds` makes every configuration
  cheaper;
- a narrower range for the parameters that drive fit time (listed under
  `drivers`); or
- if the projected cost is worth it, repeat the request with
  `search.acceptEstimatedSeconds` set to at least the projected seconds.

`search.maxSeconds` is a hard cap that no acknowledgement can raise.
