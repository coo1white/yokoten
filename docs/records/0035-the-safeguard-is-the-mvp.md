# 0035 The safeguard is the MVP

Status: accepted
Date: 2026-10-23 (UTC)

## Context

yokoten grew many parts: the guard, doctor, `init`, the bot, tiers and reviews, the
board, desks, lessons that become checks, and plans for a trust network and spending
limits. Record 0034 made one safeguard the default for everyone. The owner then asked
what the product is without the large vision, and agreed: the MVP is the safeguard.

Only the safeguard pays off the moment a person installs yokoten. Every other part asks
for setup or a team first. A list of refused commands alone is not new, so the MVP is
the safeguard with four properties together.

## Decision

The MVP is:

1. One command installs it.
2. The five protections of record 0034, with no setup.
3. A refusal a beginner reads in seconds: what was stopped, why, what to do, then the
   rule id (issue #816).
4. Tested under each AI agent yokoten supports, so the same five hold everywhere,
   including with the agent's own prompts off.

First the smallest MVP, made excellent before anything grows: points 1–3 under Claude
Code (it already has the hook, and Orca runs it) and Muse (the hackathon's own tooling).
Other agents follow. "Excellent" is tested, not felt:

- Install to first protection in one step, counted in a trial by a small model.
- Each of the five refused in a repo with no `yokoten.json`, on Linux, macOS and Windows.
- No false refusals: everyday work (status, diff, reading, editing, tests, commit, push
  of a branch) passes, with a test for each.
- Fast: the guard's check stays under 100 ms per command (baseline 88 ms, issue #408).
- Every refusal has the four lines, in English and zh-CN, and never echoes a secret.

Set aside until the MVP is done: the board, tiers and the review flow, lessons that
become checks, the trust network and spending limits. Their code stays; the guide's
first screen and the demo do not lead with them. Work is ordered MVP first.

This orders the work; it does not drop the vision. Records 0028–0031 still stand, and
talk about where yokoten goes next keeps its place in the owner's chat. The MVP is the
first stage of that road, the part a person can trust today.

## Options not taken

- Lead with the team workflow (bot, tiers, cross-vendor review). It shows more, but a
  new user gets nothing from it on day one.
- Claude Code only. Smaller, but "the same safeguard in every agent" is the part no
  single vendor offers.

## Consequences

- Issue #816 and a real Muse run come before other issues; other agents next.
- The demo leads with the safeguard holding under different agents, Muse among them.
- A new feature needs a reason it serves the MVP, or it waits.
