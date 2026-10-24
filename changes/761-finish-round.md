Added

`yokoten finish` closes a run whose agent stopped beating: it runs the full check, writes `REPORT-<issue>.md` when the agent wrote none, and sets the status to done with outcome stopped. A run that asks the owner something waits, and is not finished. Nothing is reset, deleted or pushed (#761).
