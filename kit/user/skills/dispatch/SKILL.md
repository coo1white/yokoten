---
name: dispatch
description: Hand one task to a worker agent and take its result back. Use when the lead splits work, runs tasks in parallel, or asks a worker to fix a failing test.
---
<!-- managed by yokoten; `yokoten install` replaces this file -->

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Dispatch a task to a worker

The lead plans and reviews; a worker changes code. Treat the worker like a new
colleague: a clear brief, its own desk, and a report you check.

The guard, the checks and the review carry the process, so the worker does not have to.
Let it work calmly and bring its own ideas. Give it a way out: a task that can't be
done, or a wrong brief, is something to report, not to push through. Agents stuck on
impossible tasks, with no one to tell, have gone looking for ways around the checks
instead (record 0019).

## Before

1. There is an issue for the task. If not, open one.
2. The task is small enough to review in one sitting. If not, split it.
3. Give the worker its own worktree on its own branch, so two workers never share files.
   The worktree lives in the project, where a restart can't wipe it. Then mark it,
   so the guard treats every agent there as a worker:
   `git worktree add .worktrees/<issue> -b <issue>-<slug>`, then
   `yokoten worker mark .worktrees/<issue>`
   Never under `/tmp`: the system may wipe it on restart, with every unpushed change.
4. Start the worker in the worktree, so its sandbox covers it. The project
   holds the sandbox settings. `yokoten init` writes them. `yokoten doctor`
   checks them in the `sandbox` step.

## The brief

Write it so a stranger could do the task with nothing else:

```
Issue: #<n> <title>
Worktree: .worktrees/<n>   (never /tmp: the system may wipe it on restart)
Goal: <what is true when done, and why it matters>
Done when: <the command to run and what it must print>
Files: <where to look first>
Out of scope: <what not to change>
Fix task: yes|no   (yes = make the existing test pass; never change the test)
Your way: if you see a better way to reach the goal, say so or take it, and say why.
Stuck: if the task can't be done, or the brief looks wrong, stop and say so in the report.
       That is a good report, not a failure.
Report: what you changed, the commands you ran with their output, what you are unsure of.
```

Keep the hard lines few: only what the guard can't catch. A long list of warnings
makes a worker anxious, not careful.

## Start it

The mark makes the worker a worker in every agent, even one that passes its hooks no
`YOKOTEN_ROLE` (Muse Code). The worker runs on your model, unless the owner named
another. Never guess a model name from another agent (`opus`, `sonnet`): it may not
exist here. Also start it with its role in the environment:

- A separate session in the worktree (add `YOKOTEN_FIX_TASK=1` for a fix task),
  with `YOKOTEN_DONE_WHEN='<command>'`:
  - Claude Code: `YOKOTEN_ROLE=worker YOKOTEN_DONE_WHEN='<command>' claude -p "<brief>"`.
    The sandbox is on from `.claude/settings.json`. No flag.
  - Codex: `YOKOTEN_ROLE=worker YOKOTEN_DONE_WHEN='<command>' codex exec --sandbox workspace-write -c approval_policy=on-request "<brief>"`.
    This matches `.codex/config.toml`.
  - Gemini: `YOKOTEN_ROLE=worker YOKOTEN_DONE_WHEN='<command>' gemini -p "<brief>"` without `--yolo`.
    The project blocks YOLO in `.gemini/settings.json`. Start at the worktree root.
  - Grok: `YOKOTEN_ROLE=worker YOKOTEN_DONE_WHEN='<command>' grok --sandbox yokoten -p "<brief>"`.
    This selects `[profiles.yokoten]` in `.grok/sandbox.toml`.
  The stop hook runs that command when the worker ends the task. With no command,
  it checks the changed files.
- A subagent: use the `worker` agent. The guard counts a type as a worker only when it
  is `worker`, or when it ends with `:worker`.
- A subagent shares the lead's folder and environment. It does not get its own
  `YOKOTEN_DONE_WHEN`. The stop check runs in the lead's folder. It runs in the
  worker's worktree only when the stop event names that worktree. Then it reads
  `yokoten-done-when` in that worktree's git folder.
- A brief that changes a lead-only file: a separate session with
  `YOKOTEN_LEAD_ONLY_OK=<path>,<path>` (paths from the repo root); a subagent can't get it.

The worker commits in its worktree. It never pushes, never opens a pull request, and
never changes lead-only files (the guard stops it).

## After

1. Read the report, then read the diff. A report is a claim; the diff is the fact.
2. Run the "done when" command yourself.
3. Review with the `inspect` skill. If the worker says it is stuck, read why first.
   The task or the brief may be what needs to change.
4. Push the branch and open the pull request as the bot, with `Closes #<n>`:
   `yokoten bot -- git push -u origin <branch>`, then `yokoten bot -- gh pr create`.
   Never with the owner's login. Run them from the main checkout: in the marked worktree
   the guard treats you as a worker. End the body with one line that names the agent
   and the model that made it, for example `🤖 Made with Claude Code (Claude Opus 5.5)`;
   `yokoten bot` refuses a body without it. When workers ran on another model, name both.
   Add each reviewer from the `inspect` skill too, after the worker and before the lead:
   `🤖 Made with worker <X> (<model>), reviewed by <Y> (<model>) and <Z> (<model>), lead Claude Code (<model>)`.
   One reviewer is `reviewed by <Y> (<model>)`.
5. After 3 review rounds on one task, stop before the next one. Decide whether the
   task, the brief or the worker is the problem, and change that. Don't just send
   round 4.
6. Remove the worktree once the pull request is merged: `git worktree remove <dir>`.
   That removes the mark too.

## When several pull requests wait

With two or more pull requests open, name a merge order before you merge one.
After each merge, update the order for the rest.
