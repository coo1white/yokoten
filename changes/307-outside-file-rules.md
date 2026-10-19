Fixed

The command guard from the plugin and `install` now applies file rules to an edit inside
a yokoten repo (one with `yokoten.json`), using that repo's own config, wherever the
session started. Before, only the project's own hook applied them, and Claude Code loads it
only for a session started in the repo, so a worker in a worktree outside the session's
folder could edit lead-only files unchecked. The full hook does the same for a file in
another yokoten repo (#307).
