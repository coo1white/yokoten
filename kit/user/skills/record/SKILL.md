---
name: record
description: Write down a decision so it is not argued again. Use when the user decides something about scope, design, process or a trade-off, or asks why something is the way it is.
---
<!-- managed by yokoten; `yokoten install` replaces this file -->

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Record a decision

A decision that lives only in a chat gets made again, often differently. Write it
where the next session will look.

## Where

`docs/records/NNNN-<slug>.md`, numbered in order (0001, 0002, ...). One record per
piece of work or decision. `docs/records` is a log, so it may grow past the folder cap.

## What a record holds

```markdown
# NNNN Title

Status: proposed | accepted | replaced by NNNN
Date: YYYY-MM-DD (UTC)

## Context
What forced a decision. The facts, with numbers where there are numbers.

## Decision
What we will do. Short and testable.

## Options not taken
Each with the reason it lost.

## Consequences
What gets easier, what gets harder, and what we now have to check.
```

## Rules

- **Decisions are kept.** Never rewrite an accepted decision. A changed decision is a
  new record whose context says what changed; the old one gets one line,
  `Status: replaced by NNNN`.
- **Facts are replaced.** Docs that describe how things are now (README, setup
  guides) are edited in place. Do not stack "update:" paragraphs.
- **UTC** for every date and time in a file.
- Wait for the user to agree before a record says `accepted`.
- Link the record from the issue or pull request it belongs to.
