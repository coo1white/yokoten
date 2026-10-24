# 0036 Many small releases, one approval each

Status: accepted
Date: 2026-10-23 (UTC)

## Context

The owner plans at least 100 releases in the v0.1.x line, the way Claude Code ships
(2.1.309 at the time of writing). Each fix to a guard or a refusal should reach people the
same day. Record 0035 makes the safeguard the MVP, and it improves in small steps.

Today one release costs the owner three manual steps: approve the release pull request,
create the tag in a terminal, and approve the publish in the `release` environment. A
hundred releases would be three hundred steps.

## Decision

1. **One approval per release.** The bot prepares the release pull request (changelog and
   version) by itself: once a day, or when enough changes have merged. The owner approves
   it. After it merges, the release workflow creates the tag and publishes to npm. The
   owner still decides whether and when a release ships; the tag follows only from that
   approval. Core rule 3 changes to say so, when the workflow exists.
2. **Every kind of change ships in v0.1.x.** New features too, not only fixes. The minor
   number moves (to 0.2) only for a change that breaks how people already use yokoten.
   Each release says in one plain sentence what changed.
3. **Updating must not get in the way.** A plugin update that needs no restart (issue
   #706) belongs in v0.1.1.

## Options not taken

- Keep three manual steps. Safe, but the cost grows with every release, and releases
  would slow down to save the owner's time.
- Let the bot tag without the owner. Faster, but it takes the release decision from the
  owner (core rule 3).
- Follow strict semantic versioning before 1.0 (a feature moves the minor number). It
  would end v0.1.x after a few releases.

## Consequences

- A release workflow that tags only after an owner-approved release pull request merges,
  with a test that no other path can tag. Until it exists, the three steps stay.
- Core rule 3 in `AGENTS.md`, `kit/project/AGENTS.md` and the guide changes with that
  workflow, not before.
- The `release` skill's version table changes: a feature is a patch in v0.1.x.
- Every release passes every check first; a bad release is fixed by the next small one.
