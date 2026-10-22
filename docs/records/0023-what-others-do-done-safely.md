# 0023 What others do, done safely; where they fail, a hard rule

Status: proposed
Date: 2026-10-22 (UTC)

## Context

On 2026-10-22 the owner looked at the projects that run many coding agents and said: what
they do well, and what they do badly, we do both. Each strength should be in yokoten, and
each failure should be a rule yokoten enforces.

What they do well:

- **Gas Town** (MIT) gives each task its own runtime, keeps a shared ledger of work, and
  merges through a queue that runs the checks first.
- **Cursor** found that planners, workers and a judge beat agents of equal rank.
- **Claude Code agent teams** share a task list, let teammates message each other, and
  fire hooks when a task is created or done. Messages from teammates are treated as
  untrusted.
- **PAL MCP clink** (Apache-2.0) lets one vendor's CLI call another's.
- **MCP Agent Mail** gives agents of several vendors names, inboxes and file claims.

Where they fail, from their own reports:

- Gas Town spent the user's credits and opened pull requests on other people's projects
  without the user turning that on. It was built for Claude first, and its authors report
  that a model change broke it.
- PAL clink runs the called CLI with its permission prompts turned off.
- Agent teams message only Claude to Claude. In MCP Agent Mail an agent says who it is,
  and file claims hold only if every agent keeps them.
- Cursor's single integrator became the bottleneck.

## Decision

1. **Take the strength, add the fence.** yokoten builds the useful parts (its own desk
   per task, a merge queue on green checks, planners and reviewers apart from writers,
   messages between agents of every vendor), each with the rule that keeps it safe.
2. **Hard rules, from where others failed.** These are checks and the guard, not
   advice, and an agent cannot turn them off:
   - **Spending money or posting for the user is off until the owner turns it on**: paid
     calls, posts, and pull requests or issues on projects the user does not own.
   - **Every vendor gets the same hooks.** A rule that holds for Claude holds for Grok,
     Muse, DeepSeek and the next vendor, or yokoten says which vendor it cannot reach.
   - **A model change cannot break the system.** The rules live in code and checks, not in
     what a model remembers. They are tested with weaker models (Haiku, Sonnet) too.
   - **Key code is seen by a person or another vendor's AI** before it merges: security,
     privacy, the guard, and the bot's rights (record 0021).
   - **No permission prompt is turned off for another agent.** One agent calling another
     passes on its own limits, never looser ones.
   - **Who said it comes from where it runs, never from what it claims.** A message names
     its sender by the desk it came from, and it never stands for the owner's approval.
3. **Within the law and each vendor's terms.** Code from others is used by its license
   (copied with its notice when the license allows, written fresh from a description when
   it does not). Each vendor's CLI runs with its own sign-in, used as its terms allow; one
   vendor's sign-in is not copied for another's use.

## Options not taken

- **Copy what works, add safety later.** Gas Town shows what happens: the fence comes
  after the damage.
- **Run one of them inside yokoten** (Gas Town, MCP Agent Mail). Each brings a server or
  a runtime, against record 0020 (rules run on the user's computer, no server) and the
  zero-dependency rule.
- **Only rules, no features.** Users go where the features are. A safe tool nobody uses
  keeps nobody safe.

## Consequences

- Each new feature names the failure it fences off, in its issue.
- The hard rules need tests. A rule with no test is advice.
- Some features come slower than in the projects above, because the fence ships with
  them (issue #674 is the first).
- When a vendor has no hook for a rule, yokoten says so plainly instead of claiming the
  rule holds.
