Wait up to timeoutMs for a child to finish its current work and queued follow-ups.
Returns a bounded final reply when available, with a trace reference for omitted
text. A timeout returns running status and does not cancel the child. Defaults
to 30000 milliseconds; maximum 60000. Aborting this wait does not cancel work.
