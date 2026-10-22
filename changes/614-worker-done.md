Added

A worker can end a task only when the done-when check passes (#614). The stop hook
runs the brief's command (`YOKOTEN_DONE_WHEN`, or `yokoten-done-when` in the worktree's
git folder). When the brief has none, it checks the changed files. A failing check
sends the worker back, up to three times, with the output in short. On the third, the
hook says the next stop is let through. The worker's message to the lead must start
with "NOT DONE: checks failing" and quote the output. The allowed stop writes
`.yokoten-agent.json` at the git root the event names, with `checks` set to `failing`. When the
try count cannot be saved, the next stop is let through, so a worker is never trapped.
The count is cleared after a pass and after that stop. A subagent that is not a worker
is not checked. A subagent worker shares the lead's folder and environment. The check
runs in the worker's worktree only when the stop event names it. The command uses the
platform shell, and a timeout stops the command and the programs it started. Claude
Code (Stop and SubagentStop), Codex (Stop), Muse Code (Stop), Gemini CLI (AfterAgent)
and Grok CLI (Stop) run the check. Each stop hook waits 600 seconds. DeepSeek Harness
and Antigravity CLI have no stop hook: the lead runs the check.
