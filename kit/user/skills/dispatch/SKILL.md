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
   Then mark it, so the guard treats every agent there as a worker:
   `git worktree add ../<repo>-<issue> -b <issue>-<slug>`, then
   `yokoten worker mark ../<repo>-<issue>`
4. Start the worker in the worktree, so its sandbox covers it. The project
   holds the sandbox settings. `yokoten init` writes them. `yokoten doctor`
   checks them in the `sandbox` step. The `../` path stays until #571 moves it.

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

The mark makes the worker a worker in every agent, even one that passes its hooks no
`YOKOTEN_ROLE` (Muse Code). Also start it with its role in the environment:

- A separate session in the worktree (add `YOKOTEN_FIX_TASK=1` for a fix task):
  - Claude Code: `YOKOTEN_ROLE=worker claude -p "<brief>"`. The sandbox is on
    from `.claude/settings.json`. No flag.
  - Codex: `YOKOTEN_ROLE=worker codex exec --sandbox workspace-write -c approval_policy=on-request "<brief>"`.
    This matches `.codex/config.toml`.
  - Gemini: `YOKOTEN_ROLE=worker gemini -p "<brief>"` without `--yolo`. The project
    blocks YOLO in `.gemini/settings.json`. Start at the worktree root.
  - Grok: `YOKOTEN_ROLE=worker grok --sandbox yokoten -p "<brief>"`. This selects
    `[profiles.yokoten]` in `.grok/sandbox.toml`.
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
