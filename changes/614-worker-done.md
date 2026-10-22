Added

A worker can end a task only when the done-when check passes (#614). The stop hook
runs the brief's command (`YOKOTEN_DONE_WHEN`, or `yokoten-done-when` in the worktree's
git folder). When the brief has none, it checks the changed files. A failing check
sends the worker back, with the output in short and what to fix. After three refusals
the worker may stop, and the lead sees "stopped with failing checks", never "done".
Claude Code runs this on Stop and SubagentStop; Grok CLI on Stop. DeepSeek Harness
and Antigravity CLI have no stop hook: the lead runs the check.
