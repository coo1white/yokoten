# 0029 A control plane: one event log, control loops, and service levels

Status: accepted
Date: 2026-10-23 (UTC)

## Context

[0028](0028-a-trust-layer.md) says what yokoten is. This record says how it runs a team.

A team of AI agents is a distributed system. On 2026-10-23 it failed the way distributed
systems fail when their state lives in many places and depends on someone remembering:

- Each agent's state was a status file that is overwritten. When a runner died before its
  last step, the file said "working" forever; the board showed 12 agents working while 7
  were (#685 fixes part of this).
- Finished reports waited an hour because the lead had to notice them. A follow-up waited
  forever on a condition that was already true.
- The lead ran a watchdog by hand every ten minutes to find all of this.

Other fields solved the same problem long ago:

- **Snowflake** declares how fresh data must be (`TARGET_LAG`), records when it was last
  fresh, keeps "is it scheduled" apart from "how did the last run end", and keeps a
  history of every run. A client sends heartbeats; a detached query is stopped when its
  client does not come back.
- **Kubernetes** stores the desired state, and controllers keep moving the actual state
  towards it. Liveness and readiness are probes, not promises.
- **Google SRE** sets service level objectives and an error budget, and the budget decides
  when reliability work comes before features.
- **Event sourcing** keeps an append-only log of what happened and derives every view
  from it.

The owner agreed on 2026-10-23 to build yokoten's team machinery on these ideas.

## Decision

1. **One event log is the source of truth.** Hooks and runners only append events (start,
   heartbeat, tool call, refusal, report, stop, saved, merged). Each event names the
   agent, vendor, model, role, issue and time (UTC). The board, the LEAD desk's timeline,
   the provenance ledger ([0028](0028-a-trust-layer.md) pillar 2) and the daily counts are
   views computed from the log. Status files become a cache of one view. Each event holds
   the hash of the one before, so a changed history shows.
2. **Two states, not one.** For each agent the views keep apart:
   - *Alive*: from heartbeats. An agent declares how often it beats; it is stale after two
     missed beats, gone after a longer limit.
   - *Outcome*: done, failed, timed out, refused, or stopped, with the reason.
3. **Control loops do what the lead did by hand.** The desired state is declared (issues
   and their order, seats per vendor, how soon a report must be read). Controllers compare
   it with the views and act, each one small and tested:
   - a gone agent: save its work with the full check, write its report if missing, set its
     outcome (the first controller, #761);
   - a report not read in time: route it to the area lead, then to the daily summary;
   - a follow-up whose condition is met: start it;
   - a free seat and a ready issue: start a worker.
4. **Service levels decide priorities.** Each loop has an objective (for example: a
   report is read within 10 minutes; state is at most 2 minutes old; at most one problem a
   week reaches `main`). The daily summary shows each one. When an error budget is spent,
   reliability work comes before features, without asking the owner.
5. **Events use OpenTelemetry's shape.** yokoten writes its events so that existing tools
   can read them. The open standard ([0028](0028-a-trust-layer.md) pillar 1) defines only
   the agent-work fields on top.
6. **Specs first, code later.** The event log and the status file get specs in the open
   standard (#755) first. Existing code is moved to read from the log only after that.

## Options not taken

- **Keep status files and add more checks.** Each check is one more thing to run and
  remember; the root problem, state that can go stale with no one noticing, stays.
- **A database or a hosted service.** yokoten stays self-contained ([0001](0001-yokoten.md));
  an append-only file per repo is enough, and a service would break neutrality.
- **Our own event format.** It would be one more format for every vendor and tool to learn.

## Consequences

- Easier: the board can't show a dead agent as working; the lead stops being the clock;
  the timeline, ledger and counts agree because they read the same log.
- Harder: the log grows and needs rotation; heartbeats cost a little on every agent; each
  controller must be safe to run twice.
- To check: a test kills an agent mid-task and the views show it gone with its work
  saved; the daily summary shows each service level; nothing writes a status file except
  the view that owns it.
