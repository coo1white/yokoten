Added

`yokoten finish` closes a run whose agent stopped beating. It runs the full check, writes `REPORT-<issue>.md` when the agent wrote none, and sets the status to done with outcome stopped. A run that asks the owner something waits, and is not finished. The status file's own beat decides, so a run that beat after the caller read it stays open. The file is read again after the check. A worker does not close runs; the lead does. A report that cannot be written leaves the run open. Nothing is reset, deleted or pushed (#761).
