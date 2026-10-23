# 0030 Earned autonomy: agents get more room as their record earns it

Status: accepted
Date: 2026-10-23 (UTC)

## Context

[0026](0026-the-owner-is-the-board.md) made the owner the board: he sets the rules and
should not approve each change. But on 2026-10-23 he still approved one pull request at a
time, because nothing showed which agent could be trusted with which kind of work. Trust
was a feeling, so every tier A change waited for him.

[0028](0028-a-trust-layer.md) and [0029](0029-a-control-plane.md) give yokoten what trust
needs: a ledger of who wrote, reviewed and approved each change, and an event log of what
happened. That record is evidence. Self-driving cars grade how much a car does alone, from
level 0 to level 5. An AI team needs the same, earned from evidence, not granted by hand.

The owner agreed on 2026-10-23.

## Decision

1. **Autonomy levels.** Each pair of (agent, area of work) has a level:

   | Level | What the agent may do alone | What a person does |
   |---|---|---|
   | L0 | Nothing reaches `main` without a person's approval | Approves each change |
   | L1 | Merge after a review by another vendor | Reads the daily summary |
   | L2 | Review and merge in its own area | Sees exceptions only |
   | L3 | Open and order its own work within a budget | Sets the budget and the rules |
   | L4 | Spread a lesson to other projects | Keeps the constitution |

   Today every agent is L0 for tier A and L1 for tier B and C.
2. **Levels come from the record, not from a person.** A reputation is computed from the
   ledger and the event log for each (model, area): how many changes, how many problems
   reached `main` afterwards, how many review findings held up, how often it stopped
   safely. The owner writes the rules for moving up and down (how much evidence, over what
   time). The control plane applies them.
3. **Down is fast, up is slow.** One problem that reaches `main` drops the level in that
   area at once. Moving up needs a long clean record. A level never rises in the areas
   that [0026](0026-the-owner-is-the-board.md) keeps for the owner: the constitution, the
   budget, releases, and spending money.
4. **The desk follows the level.** A higher level may widen what the desk allows (for
   example, the agent's own branch push); a lower level narrows it. The server rules stay
   the lock.
5. **Open by design.** The reputation rules and the numbers are readable by everyone on
   the team, in the board and in `yokoten` output. Across projects (opt-in, private details
   removed, [0028](0028-a-trust-layer.md) pillar 3), the same numbers show which model
   does which work well: a neutral record of AI work from real projects, not benchmarks.

## Options not taken

- **The owner grants levels by hand.** It puts trust back on a feeling, and it brings
  back the approvals 0026 removed.
- **One global level per model.** A model can be strong at docs and weak at the guard;
  the area matters.
- **Benchmarks as evidence.** Test sets can be learned; real work in real projects
  cannot.

## Consequences

- Easier: the owner stops approving routine work as evidence builds; each agent knows
  what earns more room; the hackathon story has a measurable end point.
- Harder: the rules need care so a model can't farm easy work for reputation; a level
  drop must be explained so it is fair; small samples must not move a level.
- To check: every level change names the events behind it; the first rules are written
  in a later record before any agent rises above L1.
