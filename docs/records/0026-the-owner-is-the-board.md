# 0026 The owner is the board: area leads approve, the owner sets the rules

Status: accepted
Date: 2026-10-23 (UTC)

## Context

On 2026-10-23 the owner asked to be freed from work that does not need him: "我想从无意义的工作中解放出来". That day he was asked to approve seven pull requests one by one, most of them bug fixes, and to watch the board for things the team could decide itself.

[0021](0021-ai-checks-ai.md) rule 1 says no agent approves: one agent writes, another vendor reviews, the owner approves where the tier asks. [0022](0022-a-mixed-team.md) set up five area leads, one per model line, but gave them no power to approve. So every tier A change waits for one person, and tier A covers every file in `.github/CODEOWNERS`, including the guard's bug fixes.

The owner decided: "我们有5个项目经理，完全可以放权的", and approved this split of work.

| Only the owner | The team does the rest |
|---|---|
| Direction: the vision, the story, what to build and what not to | Hand out work, write code, review, merge, rerun CI, open issues |
| Budget and limits: how many agents, how much money | Fix bugs, the guard's holes included |
| The hard lines: this constitution | Decide which tier a change is, by machine, not by the agent that wrote it |
| Taste: how it looks, whether the words are right | Sum up each day |
| What only a person may do: release, spend money | |

## Decision

The team is run as an organization with separate powers. The owner approved this table on 2026-10-23:

| Power | Who | What it does |
|---|---|---|
| Founder | The owner | The constitution, the vision, the budget, the stop switch. Reads one summary a day |
| Executive | The lead | Turns the vision into a roadmap, gives out engineer seats by the rules, sets the merge order |
| Five departments | The five area leads (0022) | Approve, merge and set priorities in their own area. They check each other: work written by one vendor is approved by another vendor's lead |
| Workforce | Fifteen engineers | Do the work; tasks go by track record (0021 rule 5) |
| Courts | The guard and cross-vendor review | Rule of law: the same rules for every agent, no exceptions |
| Audit | git, the Made-with line, the rule log | Every action is signed, traceable and can be undone |
| Legislature | Rules improve from use (0018) | The team proposes rule changes: stricter ones go the normal way, looser ones need the owner |

1. **The owner is the board.** He sets the direction, the budget, the hard lines and the taste. He is not asked to approve a single change unless a hard line says so.
2. **Area leads approve in their area.** Each of the five area leads in 0022 approves the pull requests of its area. This changes 0021 rule 1: an agent may approve, under these limits.
   - **Never its own vendor's work.** Work written by an agent of the lead's own model line is approved by another area lead. One vendor writes, another approves.
   - **Security keeps the strongest reviewer.** A change to the guard, privacy or secrets also needs an attack review by the strongest model on hand, today Claude Opus (0021 rule 3).
   - **The approval is on the record.** It names the lead, its vendor and model, and the commit it approved, on the pull request.
3. **A machine decides the tier, not the writer.** A check reads the diff:
   - **Stricter or neutral** (a bug fix, a new refusal, a new test): an area lead approves, and the bot merges when every check is green.
   - **Looser** (an existing guard test changed or removed, a refusal id removed, an exception added, a rule allowing more): the owner approves, as [0018](0018-rules-improve-from-use.md) already says. These are batched in the daily summary.
4. **The hard lines stay with the owner**, by his own hand: a release or tag, spending money, deleting data, secrets, the CI workflows, `.github/CODEOWNERS`, branch protection and this record. The guard and the commit check can be added to, never turned off ([0014](0014-safe-by-default.md)).
5. **One summary a day.** The lead sends the owner one summary a day: what merged, what is stuck, and at most three decisions, each with a recommendation he can answer in one word. A security incident is the only reason to interrupt him outside it.
6. **A stop switch.** One command from the owner stops every agent and every merge until he lifts it.

## Where this stands on the ladder

The owner approved this ladder on 2026-10-23. This record is layer 3. Layers 4 and 5 are the vision: announced loudly, not yet built.

| Layer | What it is | Today |
|---|---|---|
| 1 | **A guard**: one agent held to the rules | Done |
| 2 | **A team**: agents from several vendors working together | Being built |
| 3 | **A company**: the team runs itself, the owner is the board (this record) | Decided here |
| 4 | **An economy**: rules between many such AI organizations: a shared safety record, a track record per model across organizations, hiring across organizations, paid on green | Vision ([0020](0020-rules-the-employer-owns.md), [0021](0021-ai-checks-ai.md) rule 6) |
| 5 | **The law of AI work**: the same rules for any work AI does, not only code | Vision (0020) |

In one line: the rule of law for the agent economy. We say the whole ladder out loud, as where we are going; a layer is called done only once it runs.

## Options not taken

- **Every bug fix tier B by label.** The writer picks the label, so a change that loosens a rule could call itself a bug fix. The machine check in 3 decides instead.
- **The owner keeps approving every tier A change.** That is the work he asked to be freed from, and it does not scale to fifteen engineers.
- **A looser change merges by itself after a 24-hour veto window.** It would save the owner more time, but a loosened guard is the change an attacker wants most. Kept as a later step, if the daily summary shows looser changes are rare and always approved.
- **Approval by a vote of all area leads.** Slower, and five agents can share one blind spot. One lead from another vendor, plus the attack review for security, is enough.

## Consequences

- The lock moves. Today GitHub's code-owner review on the owner's account is the lock for every protected path. After this, for the paths that are not a hard line, the lock is yokoten's own merge check: it reads the tier from the diff and the lead's approval from the pull request. Branch protection must require that check, and only the owner may change it.
- `.github/CODEOWNERS` shrinks to the hard-line files. That is a change to repo settings; the owner makes it, or approves it in a pull request.
- The five area leads must actually run. Today none does. They are not counted in the six engineers (0022).
- We now have to check: the tier check catches every way a rule gets looser (tests for each), an area lead can never approve its own vendor's work, and the stop switch stops everything.
- Work order: the tier check and lead approvals first, then the daily summary, then the stop switch. Until the tier check exists, the owner still approves tier A.
