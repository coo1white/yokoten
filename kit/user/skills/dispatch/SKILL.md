---
name: dispatch
description: Hand one task to a worker agent and take its result back. Use when the lead splits work, runs tasks in parallel, or asks a worker to fix a failing test.
---
<!-- managed by yokoten; `yokoten install` replaces this file -->

# Dispatch a task to a worker

The lead plans and reviews; a worker changes code. Treat the worker like a new
colleague: a clear brief, its own desk, and a report you check.

## Before

1. There is an issue for the task. If not, open one.
2. The task is small enough to review in one sitting. If not, split it.
3. Give the worker its own worktree on its own branch, so two workers never share files:
   `git worktree add ../<repo>-<issue> -b <issue>-<slug>`

## The brief

Write it so a stranger could do the task with nothing else:

```
Issue: #<n> <title>
Goal: <what is true when done>
Done when: <the command to run and what it must print>
Files: <where to look first>
Out of scope: <what not to change>
Fix task: yes|no   (yes = make the existing test pass; never change the test)
Report: what you changed, the commands you ran with their output, what you are unsure of.
```

## Start it

Start the worker with its role in the environment, which it cannot change:

- A separate session: `YOKOTEN_ROLE=worker claude -p "<brief>"` in the worktree
  (add `YOKOTEN_FIX_TASK=1` for a fix task).
- A subagent: use the `worker` agent. The tool guard treats an agent type named worker
  as a worker.

The worker commits in its worktree. It never pushes, never opens a pull request, and
never changes lead-only files (the guard stops it).

## After

1. Read the report, then read the diff. A report is a claim; the diff is the fact.
2. Run the "done when" command yourself.
3. Review with the `inspect` skill.
4. Push the branch and open the pull request as the bot, with `Closes #<n>`:
   `yokoten bot -- git push -u origin <branch>`, then `yokoten bot -- gh pr create`.
   Never with the owner's login.
5. Remove the worktree once the pull request is merged.
