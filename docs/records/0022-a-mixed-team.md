# 0022 One mixed team: a lead, five area leads and fifteen engineers

Status: accepted
Date: 2026-10-22 (UTC)

## Context

[0021](0021-ai-checks-ai.md) says no agent writes, reviews and merges its own work. This
record says how this repo's team is set up to work that way.

On 2026-10-22 the owner set the team at 21 agents from five model lines:

| Model line | Effort |
|---|---|
| Claude Opus 5.5 | medium |
| Claude Sonnet 5.5 | lead high, engineer medium |
| Grok 4.7 | lead high, engineer medium |
| Muse Spark 1.3 Contributor | lead high, engineer medium |
| DeepSeek V4.1 Flash | lead high, engineer medium |

The first plan gave each vendor its own group and its own kind of work. The owner chose
mixed work instead: no agent is tied to one kind of task, and any area lead may direct
any vendor's engineer.

Limits that shape it:

- Background work may use at most half of the machine. One engineer running the full
  test suite is heavy, so at most six engineers can run at once.
- Only the lead starts a desk (issue #637).
  That is on purpose: a desk is what keeps an engineer inside its own clone.
- Agents of equal rank sharing a pool slow down and avoid hard tasks (Cursor, in 0021).
  Areas give each lead something to own.

## Decision

1. **One lead**: Claude Opus 5.5, the only agent that talks to the owner. It gives out
   the engineer seats, starts and stops desks, does the final review and sets the merge
   order.
2. **Five area leads**, one per model line, each owning an area:

   | Area | First lead |
   |---|---|
   | Security, privacy and the guard | Claude Opus 5.5 |
   | The new-user road (install, init, doctor) | Muse Spark |
   | Host, CI and commands | Grok |
   | Refactors and secret scanning | DeepSeek |
   | Docs and translations | Claude Sonnet 5.5 |

   An area lead splits work into issues, writes the brief and does the first review.
   After the hackathon areas may rotate by track record. Security stays with Opus
   (0021, rule 3).
3. **Fifteen engineers in one pool**, three per model line. Any area lead may ask for any
   engineer. An engineer works on one task at a time, in a desk: it sees only its own
   clone, cannot push and cannot open a pull request.
4. **At most six engineers run at once**, across vendors. Muse holds two seats while the
   hackathon runs. A security fix goes first. Area leads and the lead are not counted in
   the six. An engineer with no task is not started.
5. **Every task is an issue.** The issue names its area lead and its engineer before work
   starts, so two leads never send one engineer two tasks and two engineers never take
   one issue.
6. **Reviews follow 0021.** The area lead reviews first. A second review comes from a
   third vendor. The lead reviews last, and the owner approves tier A.
7. **Start small.** The first week runs one engineer per model line. The lead then
   counts conflicts and review time, and the team grows to three per line.

Model names are checked on each vendor's site before the first task.

## Options not taken

- **A fixed group per vendor.** Seats sit idle when one vendor has no work, and the
  vendors never check each other.
- **A flat pool with no area leads.** The Cursor result in 0021.
- **More than six engineers at once.** The machine cannot carry it.
- **Area leads start desks themselves.** A desk is the fence; only the lead holds the
  gate.

## Consequences

- The lead hands out every seat, so the lead's own throughput limits the team. A merge
  queue (0021, "For now") is the first fix.
- The lead's own limit on background agents changes to match rule 4.
- Issues need labels for the area lead and the engineer.
- After one week, the counts decide whether the team grows.

## Revisit

After the first week, or when the merge queue is in place.
