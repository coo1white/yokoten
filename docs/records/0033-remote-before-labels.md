# 0033 Make the repo and push before the labels

Status: accepted
Date: 2026-10-23 (UTC)

## Context

[0004](0004-the-road.md) put the stage-2 steps in one order: ci, issues, templates,
labels, milestone, board, no-build-output. Nothing in that list creates the repo on the
code host. A new project walked the road and was asked for labels and a milestone while
its work was still only on one machine. A lost laptop would lose it all.

The review of #655 found the gap. This record adds one step to 0004's table. The rest
of 0004 stands.

## Decision

- **`remote` is the first step of stage 2.** Its check passes when git has an `origin`
  remote and a branch under `refs/remotes/origin` holds a commit from this repo.
  It reads local refs only, so it needs no network and makes no call to the host.
- **Only origin's branches count.** A branch pushed to another remote is not the copy
  the road asks for: git's other remote is not where the work is backed up.
- **The fix says the whole action.** With no origin, make the repo, add it, push.
  With an origin and no pushed branch, run `git push -u origin --all`.
- **The step is first, the labels come after it.** The CODEOWNERS handle and the
  standard labels stay later in the stage, as 0004 has them.

## Consequences

- A new project hears "make the repo, add the remote, push" before it hears about
  labels or a milestone.
- The step marks no project done while its own message says the work is only on this
  machine.
- `docs/guide.md` and its zh-CN page list `remote` in the stage-2 row.
