# 0039 A Mac desk cannot open one loopback port

Status: proposed
Date: 2026-10-24 (UTC)

## Context

OpenCode 2 runs its agent in a private server, and starts that server itself with
`serve --stdio --port 0` (#770). The port is chosen by the system, and the command line
has no way to name it. The program and the server then talk over that loopback port.

On Linux and WSL2, `bwrap --unshare-all` gives the desk its own network. A loopback port
there belongs to the desk, and reaching it opens nothing on this machine.

Seatbelt on macOS shares this machine's loopback. To let the server and the program
reach each other, the profile must allow `localhost:*`. That lets the agent reach any
local service, and any local process reach a port the agent binds. The old profile
allowed outbound only to `localhost:<proxy port>`.

Record 0037 says a loosening is the owner's call. A desk therefore starts nothing for
such an agent on macOS until the lead adds `--allow-loopback`. That flag is the lead
saying the owner accepted this desk's loosening.

## Decision

1. The desk refuses on a fence that shares this machine's network (Seatbelt) when the
   agent's server picks its own port, and says so before anything starts.
2. `--allow-loopback` accepts that loosening for one desk and one run. The profile then
   opens `network-bind`, `network-inbound` and `network-outbound` on `localhost:*`.
3. `NO_PROXY` and `no_proxy` name `127.0.0.1,localhost,::1` for that agent only. Every
   other agent keeps them empty.
4. A fence with its own network (bwrap) asks nothing and needs no flag.

## Options not taken

- **Name the port in the profile.** The best answer, but OpenCode 2's server takes the
  port from its parent and the parent always passes `0`. Revisit when the program takes a
  port from its config or an environment variable.
- **No OpenCode desk on macOS at all.** Then the MacBook cannot run the vendor the desk
  was built for.
- **Allow loopback by default.** That is the loosening this record exists to avoid.

## Consequences

- The owner must accept the flag before a macOS OpenCode desk runs. Until then, macOS
  desks of other agents and every Linux desk are unchanged.
- A macOS OpenCode desk is weaker than a Linux one: the agent can reach a local service.
  The guide says so, and the changes file says so.
- When OpenCode names its port, this record is replaced: the profile then names one port.
