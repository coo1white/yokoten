---
name: rca
description: Find the root cause of a process failure and turn the fix into a check, then spread it to every project. Use when an agent broke a rule, a bad change got through, or the user says "this happened again".
---
<!-- managed by yokoten; `yokoten install` updates this file, and keeps your edits -->

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Root cause, countermeasure, yokoten

A mistake that happened once will happen again unless something stops it. A note
("be careful with X") stops nothing. A check does.

The second time the same problem shows up, fix its cause before you take the next case.

## 1. Contain

Stop the damage first: revert, close, take the token back. Say what was done.

## 2. Facts

Open an issue with the Incident template. What happened, in order, with UTC times.
Commits, commands, outputs. No blame and no guessing.

## 3. Why it got through

Ask "why" until the answer is a missing or weak check, not a person:

- The agent pushed a tag. Why? Nothing stopped `git push --tags`. Why? The guard only
  matched `git push origin v1.0`, not the flag.

Two questions decide the countermeasure:

- **Why did it happen?** (the cause)
- **Why was it not caught?** (the missing check). Fix this one even if the first
  cannot be fixed.

## 4. Countermeasure

A guard hole that a desk already contains is a normal bug, not a stop-the-line. Ask
whether the worker could reach what the hole exposes. If not, open an issue and fix it
when it is cheap. A hole that reaches past the desk is an incident.

Prefer, in this order:

1. Make it impossible (a server rule, a token without the permission).
2. Make it caught (a guard, the commit check, CI) with a test that proves the check
   catches the case.
3. Make it written (a rule in `AGENTS.md`), only together with 1 or 2.

Add the rule row to `AGENTS.md`: the rule, this incident in one line, and the check.

## 5. Yokoten: spread it

Ask: where else can this happen? Other paths in this repo, and every other project.

- Is the cause in yokoten itself? Then `yokoten learn --upstream "<what happened>"`. It
  keeps a note outside every repo, with this project hidden. In the yokoten repo, the
  session start lists it until someone opens the issue.
- For each other project, open an issue there, or note why it does not apply.
- Close the incident only when every place has a check or a recorded reason.
