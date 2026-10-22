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
3. Give the worker its own worktree on its own branch, so two workers never share files.
   The worktree lives in the project, where a restart can't wipe it. Then mark it,
   so the guard treats every agent there as a worker:
   `git worktree add .worktrees/<issue> -b <issue>-<slug>`, then
   `yokoten worker mark .worktrees/<issue>`
   Never under `/tmp`: the system may wipe it on restart, with every unpushed change.

## The brief

Write it so a stranger could do the task with nothing else:

```
Issue: #<n> <title>
Worktree: .worktrees/<n>   (never /tmp: the system may wipe it on restart)
Goal: <what is true when done>
Done when: <the command to run and what it must print>
Files: <where to look first>
Out of scope: <what not to change>
Fix task: yes|no   (yes = make the existing test pass; never change the test)
Report: what you changed, the commands you ran with their output, what you are unsure of.
```

## Start it

The mark makes the worker a worker in every agent, even one that passes its hooks no
`YOKOTEN_ROLE` (Muse Code). The worker runs on your model, unless the owner named
another. Never guess a model name from another agent (`opus`, `sonnet`): it may not
exist here. Also start it with its role in the environment:

- A separate session: `YOKOTEN_ROLE=worker claude -p "<brief>"` in the worktree
  (add `YOKOTEN_FIX_TASK=1` for a fix task).
- A subagent: use the `worker` agent. The tool guard treats an agent type named worker
  as a worker.
- A brief that changes a lead-only file: a separate session with
  `YOKOTEN_LEAD_ONLY_OK=<path>,<path>` (paths from the repo root); a subagent can't get it.

The worker commits in its worktree. It never pushes, never opens a pull request, and
never changes lead-only files (the guard stops it).

## After

1. Read the report, then read the diff. A report is a claim; the diff is the fact.
2. Run the "done when" command yourself.
3. Review with the `inspect` skill.
4. Push the branch and open the pull request as the bot, with `Closes #<n>`:
   `yokoten bot -- git push -u origin <branch>`, then `yokoten bot -- gh pr create`.
   Never with the owner's login. Run them from the main checkout: in the marked worktree
   the guard treats you as a worker. End the body with one line that names the agent
   and the model that made it, for example `🤖 Made with Claude Code (Claude Opus 5.5)`;
   `yokoten bot` refuses a body without it. When workers ran on another model, name both.
5. Remove the worktree once the pull request is merged: `git worktree remove <dir>`.
   That removes the mark too.
