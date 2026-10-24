Fixed

`yokoten bot -- git push` refuses a commit whose time is not UTC, and pushes nothing (#789).
It reads only the commits the push sends, so a new branch is not refused for an old time zone the remote already has. What the remote already has comes from the remote itself (`git ls-remote`), never from a local tracking ref: an agent can point `refs/remotes/...` at the tip it is about to push.
`--tags`, `--mirror` and a refspec pattern are read too; a delete, as `--delete` or as `:branch`, sends no commit. The first word of a push may be a remote name, a path or a URL.
`yokoten doctor` names a desk or a worktree that has no `core.hooksPath` (#789). A session lists at most three of those notes, then how many more.
