# 0018 What yokoten adds, and how its rules get better

Status: accepted
Date: 2026-10-22 (UTC)

## Context

Coding agents already have hooks, permission rules, a sandbox, checkpoints, subagents in
their own worktrees, plugins and a status line. Rebuilding these would be slow, and the
copy would always be behind. What no agent has is a way to work under the same rules as
agents from other vendors, in one team the owner can see.

Record 0015 (proposed) says yokoten works like a framework. This record says what that
framework adds, and how its rules change over time.

A rule set that never changes goes stale. Some rules stop too much and train people to
click "allow". Others miss a new way to do damage. Coding agents improve because their
makers watch how they are used. yokoten needs the same loop, without sending anyone's
data away and without letting agents weaken their own rules.

## Decision

On 2026-10-22 the owner decided:

**yokoten adds three things, and reuses the rest from each agent:**

1. One set of rules, the same for every vendor's agent.
2. Translating those rules into each agent's own hooks and settings.
3. A board to run a team of agents from different vendors (record 0017).

**The rules get better from use, in four steps:**

| Step | What happens | Who |
|---|---|---|
| Log | Each stop and the owner's answer go to a log on this computer (issue #621). | The guard |
| Sum up | Per rule and per vendor: how often it stopped, and how often the owner allowed it anyway. | `yokoten review` |
| Propose | The summary becomes an issue or a pull request: change a rule, change what an agent is told, add a test. | The lead |
| Approve | Every change to a rule is tier A. | The owner |

**Agents never weaken their own rules.** A change that makes a rule stricter, or fixes a
hole, follows the normal path. A change that removes a rule, adds an exception or makes a
rule allow more needs the owner's approval and a reason in the pull request. An agent
being stopped often is a reason to look at the rule, never a reason by itself to drop it.

**Nothing leaves the computer by default.** The log stays on the user's computer. If users
later want to send feedback to the project, they run a command, see exactly what is sent
first, and send only counts (rule, vendor, answer). Never commands, paths or code.

**No feature needs a yokoten server.** Everything a user makes with yokoten lives with them:
tasks in their issues, decisions in their repo, logs on their computer. If the project
stopped tomorrow, users would lose nothing they made. A hosted extra may come later, but
the free tool must work fully without it, and users can take their data out at any time.

Vibe Kanban showed why. It was widely used, but its company found no way to pay for it
and closed in April 2026, less than a year after launch. Its hosted issues, comments and
projects were deleted after 30 days, and only what was on users' own computers kept
working.

## Options not taken

- **Rebuild what agents already have.** Slow, always behind, and it splits users away from
  their agent's own updates.
- **Let agents tune the rules from the stop counts.** An agent stopped by a rule would
  learn to argue the rule away. The rules exist for exactly that case.
- **Send usage data to the project by default.** Agent logs hold commands, paths and code.
  Sending them breaks the promise that private data stays private.

## Consequences

- A feature that an agent already has is not built in yokoten. The issue says which agent
  feature it uses instead.
- Every stop needs a stable rule name, so the log and the summary can count it.
- The reviewer checks that a rule change says whether it makes the rule stricter or looser.
  A looser rule without the owner's approval is a finding.
