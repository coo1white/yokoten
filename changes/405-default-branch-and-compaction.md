Fixed

The session start no longer says "run `yokoten init`" for a file that is on the default
branch but not on this branch (#405). This holds for the steps that only check that files
exist: AGENTS.md, the templates, `changes/` and the security files. It names the default
branch from origin/HEAD, else init.defaultBranch, else main, with one `git ls-tree` and no
network. `yokoten bot` and the road's bot step now read the bot settings the same way:
from the environment, then from `~/.config/yokoten/keys.env`. The bot step names the
missing piece (#364). After Claude Code compacts the context, the session start repeats
only the notes that changed. It keeps what each session heard in
`~/.config/yokoten/sessions/`, and removes files older than 7 days.
