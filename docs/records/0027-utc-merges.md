# 0027 Merge commits stay on UTC when the bot merges

Status: accepted
Date: 2026-10-23 (UTC)

## Context

Core rule 12 says times are UTC. A time zone narrows down where someone lives.
Squash commits that GitHub writes can still carry the merging account's zone.
Branch commits made with `TZ=UTC` were already UTC.

The zone follows the account that merges. It does not follow the author.
A browser merge and `gh pr merge --squash` with a person's token do the same thing.
What changed for the bot between two older pull requests is still unknown.
This record does not guess a GitHub change.

## Decision

`yokoten bot --` runs its command with `TZ=UTC`.
`gh` sends that value as the `Time-Zone` header.
GitHub writes that zone into a commit it creates, such as a squash merge.
A merge made the yokoten way goes through the bot.
A person's own merge does not.

The merge skill says: merge only through the bot, then fetch and read `origin/main`.
Stop when the zone is not UTC. Report a count. Leave the zone value out.
Leave the commit in place. History stays as it is.

## Consequences

Doctor does not yet count not-UTC merge commits on the default branch.
That count remains issue #488. Link it with `Refs #488`.
History is not rewritten.
