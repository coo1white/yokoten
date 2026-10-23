# 0036 One line of work: the story first

Status: accepted
Date: 2026-10-23 (UTC)

## Context

The open issues were a flat list. A reader could see every task, but not which tasks
belonged together, what came first, or who set the order. On 2026-10-23 the owner
approved a grouping: each area of work is one line, and the line's issue lists its tasks
in priority order.

The first line is the story: the site, the README, the docs and Japanese. The owner set
the Grok docs lead over it (#720); [0026](0026-the-owner-is-the-board.md) gives an area
lead that power. That moves docs and translations from the Claude Sonnet 5.5 lead in
[0022](0022-a-mixed-team.md). A later rotation gets its own record, as
[0003](0003-docs-in-repo.md) asks.

This record is a snapshot. Issue #720 is the live list. The lead ticks it by hand in the
daily summary.

## Decision

1. **A line of work is one issue.** The issue names the goal, the lead who owns the line,
   and its tasks in priority order, top first.
2. **The lead takes the top open task first.** The list is the plan. The lead does not
   reorder it; the owner sets a new order, in the issue or in a new record.
3. **A line is not a pull request.** Each task keeps its own issue, branch and pull
   request. One pull request still has one purpose.
4. **A big task is split, not skipped.** If one task is too big for one run, the lead
   does the first useful part and says what is left.
5. **The issue is the live list.** A task's pull request closes that task's issue, not
   the line. The lead ticks the line by hand while any task is open. A changed order
   gets a new record that points back here.

The story line holds these tasks, in this order:

| # | Task | Milestone |
|---|---|---|
| 1 | #702 site: tell the team story, one rule set for every vendor | v0.1.1 |
| 2 | #618 readme: one set of rules for every agent, and a team board | v0.1.1 |
| 3 | #487 docs: one count of the agents yokoten guards | M1 |
| 4 | #530 docs: a beginner page on the habits this repo uses | M1 |
| 5 | #531 kit: move the habits kept only in memory into the repo | M1 |
| 6 | #545 docs: explain the PR review bots beginners will see | none |
| 7 | #375 site: make yokoten.app easy to find on Google | M2 |
| 8 | #484 site: see which agents visit, and what they run | M2 |
| 9 | #485 site: a free repo scan as the front door | M2 |
| 10 | #85 site: add Docs pages rendered from the repo's Markdown | M2 |
| 11 | #631 docs: build the docs site with Starlight | M2 |
| 12 | #389 docs: case study from a private project run with yokoten | M2 |
| 13 | #121 docs: add Japanese as a third language for users | M2 |
| 14 | #122 site: add Japanese pages and a three-way language switch | M2 |
| 15 | #124 site: add Japanese subtitles to the promo video | M2 |
| 16 | #84 site: add subtitles in each language to the promo video | M2 |

The order runs from the words a reader meets first to the language they read. The issue
is the source; this table is the snapshot of 2026-10-23.

## Options not taken

- **A roadmap file in the repo.** It copies the issue list. The copy drifts, and it looks
  like the todo file that core rule 1 forbids.
- **One issue per milestone.** A milestone says when, not why. A reader still sees no
  line.
- **The board as the plan.** The board shows today. The line shows the order and the
  reason.

## Consequences

- A reader can see the plan from one issue, and each task still has one owner and one
  change.
- The list goes stale between summaries. The lead carries the ticks; this record keeps
  the order of 2026-10-23.
- The story line changes the words first (#702, #618), then how readers find them (#375,
  #484, #485, #85, #631, #389), then Japanese (#121, #122, #124, #84).
- Docs and translations now answer to the Grok docs lead. The table in 0022 is a
  snapshot; this record replaces one row of it.
