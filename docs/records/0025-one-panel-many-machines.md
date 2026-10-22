# 0025 One panel, many machines: the user's own fleet of agents

Status: proposed
Date: 2026-10-22 (UTC)

## Context

On 2026-10-22 the owner asked for one panel that manages agent work across every machine
they have:

1. Windows with WSL;
2. a MacBook's terminal;
3. a Linux VPS;
4. server groups at a cloud provider (AWS, Google Cloud).

The same day this repo started using a second machine: the lead runs the full test suite
on a MacBook over ssh, in a temp clone, and the Mac never pushes. The MacBook's 16 GB sat
idle while WSL is held to half its resources.

Others do parts of this. Claude Code shows and messages sessions on other machines, and
runs sessions in Anthropic's cloud. Cursor's background agents, OpenAI's Codex cloud and
GitHub's Agent HQ run tasks on their own clouds. Each manages one vendor's agents, or runs
them on the vendor's machines. None is known to manage every vendor's agents on the user's
own machines under one set of rules.

The name for this is agent orchestration across a fleet of machines: a **control plane**
(the panel, which decides and watches) and **workers** on many hosts (which do the work).
It is not distributed computing in the narrow sense, which splits one computation across
machines; each task here runs whole on one machine.

## Decision

Proposed: yokoten manages agents on all the user's machines from one panel, with the same
rules on each.

1. **The panel runs on the user's own computer**, not on a server we host (record 0020).
   It reaches each machine over channels the user already owns: ssh, Tailscale, or a
   cloud provider's own command-line tool.
2. **Every machine runs the guard itself.** The panel sends tasks and reads results; it
   is never the only fence. A machine the panel cannot reach keeps its rules.
3. **Secrets stay where they are.** The bot key and each vendor's sign-in are not copied
   between machines (record 0023). A machine without a needed sign-in says so, and the
   owner signs in there.
4. **Only the lead's machine pushes.** Other machines commit; the lead fetches, reviews
   and pushes as the bot.
5. **Limits count across machines.** The number of engineers at once (record 0022) is
   about how much the owner can review, so it counts every machine. Each machine also has
   a resource cap, like WSL's half.
6. **Steps.** First the board shows and starts work on two machines (WSL and the Mac).
   Then a VPS. Then cloud machines, each started and stopped by the panel, so a forgotten
   one does not keep costing money; spending stays opt-in (record 0023).

## Options not taken

- **A hosted control service.** Easier to reach from anywhere, but it is a server we run,
  holding every user's machine access. That breaks record 0020 and makes us a target.
- **Each vendor's own cloud.** Simple, but it splits the work by vendor and puts it on
  machines the user does not control.
- **Wait until after the hackathon to decide.** The two-machine step is small, and it
  shows the idea at the hackathon.

## Consequences

- The board learns machines: which are reachable, what each runs, its load (issue #682).
- New risk: the panel holds the user's ssh access to every machine. It must never print
  addresses or user names, and it must refuse a machine the owner did not add.
- Cloud machines cost money; they start only when the owner turns that on, with a limit
  (issue #640).
- Tests need a second machine or a fake one; the fake comes first.
