Added

A safe exit for every agent, so no run loops forever (#711). The tool-call guard counts,
per session, the same refusal for the same command shape and the same failing command.
At the third repeat the refusal becomes a stop message: stop, go back to your last
anchor, or write your report. A call that succeeds resets the count. The count lives in
yokoten's config folder and is never a reason to trap a session.

A worker records an anchor when its checks pass and its tree is clean. An anchor is a
commit. `yokoten anchor` lists them, newest first, and says the way back:
`git switch -c try-2 <commit>`. Nothing is reset or deleted.

The board stops a worker it starts after three hours unless yokoten.json sets
`worker.timeLimitMinutes`. The board writes `REPORT-<issue>.md` from the last output
when the worker wrote none, and shows "stopped by the time limit". The dispatch brief
now carries the anchors, the stop rules, and the time limit.
