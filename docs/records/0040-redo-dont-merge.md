# 0040 Redo a conflicting pull request on main; never merge main into it

Status: proposed
Date: 2026-10-24 (UTC)

## Context

The team merged 413 pull requests in the eight days to 2026-10-24; the other commit
on main is the import of 0.1.0. On that day the team had 43 open. Most of the work on
the second machine was rework. A pull request merged, every pull request on the same
files conflicted, a merge round edited them by hand, a new review found new points,
and the loop began again. A hand merge also rewrote other work: pull request #820
rewrote the refusal text that #800 had just shipped.

The pull request is a tool for slow human coordination. An AI team is not slow, and
code is cheap. What is scarce is the owner's attention and a main line that stays
coherent. A queue of 43 open pull requests spends both: each one waits on a review,
and each one is a copy of a main line that moves 50 times a day.

The overlap is measurable on the main line. Each squash commit is one pull request, so
`git log` holds every merged change and the files it touched. Days are UTC.

| Day | Commits on main | Shared a file with another pull request merged that day |
|-----|--------|--------------------------------------------------------|
| 2026-10-17 | 35 | 35 |
| 2026-10-18 | 63 | 62 |
| 2026-10-19 | 85 | 85 |
| 2026-10-20 | 39 | 38 |
| 2026-10-21 | 49 | 46 |
| 2026-10-22 | 54 | 47 |
| 2026-10-23 | 58 | 52 |
| 2026-10-24 | 31 | 28 |
| **Total** | **414** | **393 (95%)** |

- **357 of the 414 commits (86%) touched a file that another pull request had
  changed in the six hours before.** Within 24 hours the count is 387 (93%).
- **203 of the 414 commits (49%) touched `docs/guide.md`.** On 2026-10-19 alone,
  47 pull requests did. The next files: `docs/zh-CN/guide.md` (98 extra same-day
  touches), `test/cli.test.ts` (91, and 46 in one day), `src/rules/message.ts` (70),
  `src/setup/doctor.ts` (67).
- **301 of the 414 commits (73%) added a file in `changes/`.** No two of them touched
  the same file, so `CHANGELOG.md` never conflicted (PR #134). The team already
  solved this class of conflict once, by giving each task its own file.

The same-day number is a ceiling, not a conflict count. Two changes can touch one file
and merge clean. But it is the ceiling that produces the rework, and it is cheap to
watch.

Two series are not in this clone: open pull requests per day, and review rounds per
merged pull request. This desk has no GitHub access, and the runner scripts keep that
history on the lead's machine. They are owed before the owner accepts this record.
The ledger entry in point 3 is what makes them measurable next time.

## Decision

1. **Redo, do not merge.** A pull request that conflicts with `main` is rebuilt on the
   current `main` from its task: the issue, the pull request text and the last review.
   The old commits stay on a `redo/<number>` ref, for reference only. Main's newer
   work is always the base. A worker never merges `main` into its branch by hand.
2. **Declare the files, not the module.** Before a task starts, its issue names the
   files it will touch. Two tasks run together when their lists do not overlap. Two
   tasks that share a file wait in line, or become one task. The declaration is a
   promise, not a lock: a worker that must touch an unlisted file adds it to the issue
   and reports it.
   The measured overlap says a folder is too coarse a unit. `docs/guide.md`,
   `test/cli.test.ts` and the `changes/` pattern show that most tasks meet in a few
   files, not in a folder.
3. **Review by evidence.** A change carries the behaviour it changes, the tests that
   prove it, and the output before and after. The reviewer checks the intent and the
   evidence, not every line. The evidence becomes one ledger entry, so the next record
   can count rounds and rework instead of guessing.
4. **A work-in-progress limit.** No new task starts while the open pull requests pass
   the limit. Start at 15, the number the runner uses today. The owner may change it
   once two weeks of ledger entries exist. A lead may
   exceed it once for a task that clears the queue: a redo of a blocked pull request,
   or a merge.

This is layers 2 to 4 of [0029](0029-a-control-plane.md),
[0030](0030-earned-autonomy.md) and [0031](0031-the-boards-attention.md) running. It
adds no layer.

**Way back** ([0014](0014-safe-by-default.md)):

- Redo: the old commits are on the ref, so a wrong rebuild is compared and one hunk is
  taken from it. The pull request says why in one line.
- Declared files: a worker that needs another file reports it. The lead may run the
  two tasks together when the file is new, or when the change is a one-line import.
- Evidence: a reviewer may ask for a line-by-line read when the evidence is thin. A
  tier A change still goes to the owner.
- Limit: the lead may start one more task to clear the queue. Every use is named in
  the daily summary.

## Options not taken

- **GitHub's merge queue.** It tests each pull request on the current base, so it
  catches "green alone, red together" (rule 9). It does not rebuild a branch from its
  task, and it does not stop a conflict or a review round. With 95% of pull requests
  sharing a file with another that day, the queue would mostly serialize the team, and
  a conflict becomes a queue failure that a person fixes by hand. It also does not cap
  the open count. It is a useful check where the host offers one, not the answer to
  rework.
- **A cap on review rounds alone.** [0019](0019-a-way-to-say-no.md) already caps a
  task at three rounds. Used alone, the cap stops the loop by merging round three or
  closing the task. The conflict is what starts most rounds, so the cap spends the
  owner's attention on choosing a round instead of removing the cause. It also rewards
  a thin first review.
- **Merging `main` into the branch.** That is today's path. It makes the reviewer read
  a merge, and a wrong resolution rewrites another task's work (#820 and #800).
- **One human reviewer for every pull request.** That is the model the pull request
  was built for. It does not hold at 52 changes a day.

## Consequences

- A conflict costs a rebuild from the task, not a hand merge. The rebuild is fresh, so
  it cannot carry a stale base into `main`.
- An issue that does not name its files is not ready to start. A brief that is vague
  now costs one question, not one redo.
- Hot files still serialize. `docs/guide.md` takes half the work, so two changes to it
  on one day become one task, or wait. That is the price of a coherent main line.
- The limit can leave a desk idle. An idle desk is cheaper than 43 open pull requests,
  and the idle time is not lost: the runner starts the next task when a slot frees.
- These numbers are a first measurement, not a baseline. Without a ledger entry,
  rounds and redo outcomes stay unknown, and the next decision repeats this guess.

## Evidence

First measurement, 2026-10-24, in this clone, from `main` at 4c7c9be. These are the
numbers as they stood that day; the next measurement replaces them.

- Per day and total: `git log --pretty='%cI'`, grouped by the UTC day of the commit
  date; the first commit, "feat: yokoten 0.1.0", carries no pull request number.
- Same-day overlap: `git log --no-merges --pretty=format:'C %h %cI' --name-only`, then
  for each UTC day the set of pull requests per changed file. A pull request is counted
  once when it shares any file with another pull request of that day.
- 6 and 24 hours: the same log in commit order. Each file keeps the time of the last
  commit that touched it. A pull request is fresh when one of its files was touched
  within the window by an earlier pull request.
- Hot files: the same log, counting a file once per pull request that touched it.
- Change files: `git log --name-only`, counted by the `changes/` prefix.
- Merges a day: 414 over eight days is 52. The 2026-10-24 row is a partial day.

Still owed, on the machine that holds the bot's token: open pull requests per day,
and review rounds per merged pull request. The runner scripts already track both.
