# 0028 A trust layer for AI teams: the framework above the details

Status: accepted
Date: 2026-10-23 (UTC)

## Context

AI made writing code cheap. What is now scarce is trust: can this change be trusted,
who wrote it, who checked it, who said yes, and where did a problem come from.

On 2026-10-23 this repo ran about twenty agents from three vendors (Grok, DeepSeek,
Claude) under one lead and one owner. In one day:

- Cross-vendor reviews found eleven holes or wrong first drafts before they merged,
  among them three ways around the guard (#734, #744, #745) and an Approve that could
  count from the wrong CODEOWNERS file (#723).
- The guard's text reading was beaten for the eleventh time. Bash has endless ways to
  say the same thing; a list of what to refuse never ends.
- The team's own machinery failed: finished reports sat unread, a follow-up waited on
  itself, runners died before they saved work, a model signed with the wrong vendor's
  name (#747, #748). Each was a lesson every team that runs agents will meet.

The owner looked at this and asked for the bigger picture first, then the details. He
agreed to the points below on 2026-10-23.

## Decision

### 1. What yokoten is

yokoten is a **neutral trust layer** between any AI agent and your code. In one line:
**the Toyota Production System for AI software factories.** The name already comes from
it, and the parts already match:

| Toyota | yokoten |
|---|---|
| Poka-yoke: make the mistake impossible | The desk (a fenced clone), and the guard |
| Jidoka and the andon: stop the line on a fault | The stop check, the stall watchdog (#747) |
| Independent inspection | One vendor writes, another reviews ([0021](0021-ai-checks-ai.md)) |
| Yokoten: one line's fix goes to every line | A lesson becomes a check, and the check spreads |
| The visual board | The team board |

No single AI vendor can be this layer for the others. Neutrality is the point.

### 2. Three pillars

1. **An open standard.** yokoten writes down, as public specs, the shapes it already
   uses: one transcript shape for every vendor (#698), the agent status file, the
   Made-with line, the risk tier, the desk contract. Any vendor's agent that follows them
   joins a yokoten team, the way an editor joins a language through LSP.
2. **A provenance ledger.** Every change can be traced to the model that wrote it, the
   model that reviewed it, and the person who approved it. The Made-with line and the
   records are its first form. It grows into an AI bill of materials, like an SBOM.
3. **A lesson network.** Yokoten taken all the way: a lesson one project learns becomes
   a check that every project can take. Across many projects, opt-in and with private
   details removed, it also shows which model does which kind of task best for its cost
   (linked to spending limits, #640).

### 3. The main line of defence is the desk

Safety comes from what an agent **can't reach**, not from reading what it types. A
worker runs in a desk by default: its own clone, no tokens, no network but its API,
`.git/config` and the hooks read-only, the home folder hidden. The guard stays, to stop
mistakes and explain the rules, but it is no longer the security boundary. New safety
work goes to the desk first; a guard hole is fixed when it is cheap, and is not a reason
to stop the line. The server (branch rules, CODEOWNERS, protected releases) stays the
lock, as [0001](0001-yokoten.md) says.

### 4. yokoten runs yokoten

The team's machinery (handing out work, waiting on reports, the merge order, finding
stalled work, saving a worker's work) moves out of the lead's scripts into yokoten,
with tests and cross-vendor review (#709, #747, #748, #736). What fails for this team
fails for every user, so it belongs in the product.

### 5. The order of work

Framework first, then details. Each pillar gets one short spec under `docs/` before
its features: what the shape is, who writes it, who reads it, how it is checked. A
feature issue names the pillar it serves. Work that serves none waits.

## Options not taken

- **Keep yokoten a guard and a guide for one person.** It works, but it is a tool any
  vendor can copy into its own agent. The cross-vendor team is what only a neutral
  layer can do.
- **Keep the guard as the security boundary and patch each hole.** Eleven rounds show
  the cost grows without end. A boundary has to be something an agent can't reach.
- **Build a hosted service first.** The lesson network needs many projects, but a
  service before an open standard locks users in, which breaks neutrality. The standard
  and the local tools come first; any shared service is opt-in and later.

## Consequences

- Easier: a clear yes or no for each feature (which pillar does it serve), a story for
  the hackathon with real evidence from 2026-10-23, and a reason for vendors to join.
- Harder: three specs to write and keep stable; a public standard means changes need
  versions. The desk must work on macOS and native Windows to be the default (#669).
- To check: every feature issue names its pillar; the daily summary counts problems
  caught before merge and problems that reached `main`; the desk is the default for
  workers on every platform yokoten supports.
