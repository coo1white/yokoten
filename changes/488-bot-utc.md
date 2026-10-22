Fixed

`yokoten bot --` runs its command with `TZ=UTC`, so `gh` sends `Time-Zone: UTC` and the commits GitHub makes, such as a merge, stay on UTC whatever the session's zone is. The tool-call guard trusts `TZ=UTC` next to a post, as an `export` or a command's own prefix, so it no longer stops a `--body-file` post that sets it; any other zone or name is still refused (#488).
