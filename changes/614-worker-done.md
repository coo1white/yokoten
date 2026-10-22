Added

A worker can end a task only when the done-when check passes (#614). The stop hook
runs the brief's command (`YOKOTEN_DONE_WHEN`, or `yokoten-done-when` in the worktree's
git folder). When the brief has none, it checks the changed files. A failing check
sends the worker back, up to three times, with the output in short. On the third, the
hook says the next stop is let through. The worker's message to the lead must start
with "NOT DONE: checks failing" and quote the output.

The allowed stop writes `.yokoten-agent.json` in a linked worktree. It sets `checks`
to `failing`. A pass sets `checks` to `passing`. The main checkout is left unchanged.
The lead reads that file. The board will show `checks` later (#603). `init` adds the
file to `.gitignore` when that line is missing. A link at that path is left unchanged.

A worker type is exactly `worker`, or a name that ends with `:worker`. A name such as
`code-worker` is not a worker. Re-mark such an agent as `worker`, or use a name that
ends with `:worker`.

When the try count cannot be saved, the next stop is let through if `stop_hook_active`
is set. It is also let through when this same worker was refused in the last 5 minutes.
That covers a runtime that never sets `stop_hook_active`. A worker is never trapped.
The count is cleared after a pass and after that stop. Count files older than one day
are removed when a new count is written. A subagent is checked only when its own type
is a worker. The parent session's role does not make it one.

The command uses the platform shell. A timeout stops the command and the programs it
started. On Windows, yokoten stops the tree while the shell is still running. Claude
Code (Stop and SubagentStop), Codex (Stop), Muse Code (Stop) and Grok CLI (Stop) each
wait 600 seconds. Gemini CLI (AfterAgent) reads `timeout` in milliseconds, so its hook
waits 600000 milliseconds (10 minutes). Muse Code settings hooks, including
`.muse/hooks.json`, read `timeout` in seconds. That is Muse's documented unit, and the
1.4.11 build keeps it apart from a plugin hook's `timeoutMs`. DeepSeek Harness and
Antigravity CLI have no stop hook. The lead runs the check.
