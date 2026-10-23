# 0033 The Windows desk uses a local sandbox account

Status: proposed
Date: 2026-10-23 (UTC)

## Context

A desk is the safety boundary for a worker (#637). Linux and WSL2 use `bwrap`; macOS
uses Seatbelt. Native Windows has neither, so a worker there gets the guard only. The
owner asked to build the Windows desk later as an experimental feature (#669).

OpenAI's Codex sandbox (Apache-2.0) was studied. It starts the agent with a
write-restricted token. ACLs let that token read the system and write the workspace,
and a firewall rule holds the network. Codex tried AppContainer first and dropped it as
the core, because git, shells and build tools do not fit it. Its token model fits the
desk contract, so this record takes that, not AppContainer.

## Decision

- **A local sandbox account, not a shipped binary.** Setup creates one hidden local
  user, `YokotenDesk`, with a random password kept for the owner by DPAPI. The helper
  starts the agent as that user with a restricted token, so its own SID is the one ACLs
  and the firewall rule name. The helper is PowerShell with a small C# part that
  `Add-Type` compiles at setup; Windows 11 has both. A binary would need a build and a
  signature for each architecture.
- **The plan becomes ACLs.** The sandbox account is denied on every hidden folder: the
  lead's home, every profile folder, the desk's parent and the other drives. It is
  denied write on `.git/config`, `.git/hooks` and the worker mark. It is allowed full
  control on the desk, its state folder and a private scratch folder. Windows applies an
  explicit deny before an allow, so the order is the contract's order.
- **One admin setup, one admin undo.** `yokoten desk setup --windows` creates the
  account, the ACLs and the firewall rule, then runs the #637 contract test inside the
  fence. It writes a marker only when every check passes. `--undo` removes every ACE,
  the account and the rule it added, and the marker.
- **Experimental and off until the test passes.** The desk refuses to start when the
  marker is absent, with the reason. The guide and the command say "experimental" until
  the test has passed on real Windows 11 machines. WSL2 stays the way for everyone else.
- **Network by a firewall rule for that account.** The proxy stays outside, as on the
  other systems. Windows Firewall matches a local user, so the account's outbound
  traffic is blocked and the agent reaches its API only through the proxy.

## Options not taken

- **AppContainer.** Codex dropped it for the same tools, and the desk needs git and
  Node. A fence that stops a worker's test suite is not a desk.
- **Docker or Windows Sandbox.** Docker is another runtime to trust. Windows Sandbox is
  a whole VM and needs Windows Pro. The desk must work on Windows 11 Home.
- **A `.exe` helper in the package.** Two architectures, signing, and a build step; the
  PowerShell helper is source a reader can check.
- **ACL denies on the owner's own account.** A deny for the owner would also fence the
  lead, and undo could miss a folder. A separate account fails closed.

## Consequences

- A Windows run needs one setup before the first desk, and the setup needs an
  administrator. Undo is one command.
- The account is a real local user. The guide must say so before it is on, and `doctor`
  should name it when it is there.
- Windows Firewall does not filter loopback. The agent can still reach a service on
  `127.0.0.1` that the owner runs. This is weaker than the empty network of the Linux
  desk and must be in the guide and the test.
- The contract test is the gate. Until it passes on real Windows, the backend stays
  behind the experimental marker and the guide says WSL2.
