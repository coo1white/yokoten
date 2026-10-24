Fixed

`yokoten bot -- git push` refuses a commit whose time is not UTC, and pushes nothing (#789).
It reads only the commits the push sends, so a new branch is not refused for an old time zone the remote already has. `--tags`, `--mirror` and a refspec pattern are read too; a delete sends no commit.
`yokoten doctor` names a desk or a worktree that has no `core.hooksPath` (#789). A session lists at most three of those notes, then how many more.
