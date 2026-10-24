---
name: yokoten
description: The entry to the yokoten skills. Use when the user asks to adopt yokoten, or to hand off, review, merge, diagnose, record or release work.
---
<!-- managed by yokoten; `yokoten install` updates this file, and keeps your edits -->

# yokoten

This one entry keeps yokoten's other skills out of your global skill list. Read the
skill you need from the installed copy: `~/.local/share/yokoten/kit/user/skills/<name>/SKILL.md`.
From a clone, read `kit/user/skills/<name>/SKILL.md`. With the Claude Code plugin, use
`yokoten:<name>` instead.

| Ask | Skill |
|-----|-------|
| adopt the practices in a project | `yokoten` |
| hand a task to a worker | `dispatch` |
| review a pull request | `inspect` |
| merge a pull request | `merge` |
| find the cause of a failure | `rca` |
| write down a decision | `record` |
| prepare a release | `release` |

When the user asks to adopt yokoten, start with the adoption skill. It walks the
practices with the user and changes nothing until they decide.
