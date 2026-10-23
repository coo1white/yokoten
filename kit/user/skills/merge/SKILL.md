---
name: merge
description: Merge a pull request through the bot and stop when the new commit is not UTC. Use when the lead merges.
---
<!-- managed by yokoten; `yokoten install` replaces this file -->

# Merge through the bot

Only the bot merges. A person's merge writes that person's time zone into the commit GitHub creates.

## Steps

1. Merge with `yokoten bot -- gh pr merge --squash`. Leave the owner's token unused.
2. Fetch with `git fetch`. You are still on the feature branch.
3. Read the default branch with `git log -1 --format=%ci origin/main`.
4. Stop when the line does not end in `+0000`. Say that the merge is not UTC.
5. Do not paste that line into an issue, a pull request, or a report.
6. Leave the commit in place.

`yokoten bot` already sets `TZ=UTC`. You do not set a zone yourself.
When the default branch has another name, use that name in the log.
