# 0012 Doctor checks the machine that agents run on

Status: accepted
Date: 2026-10-20 (UTC)

## Context

A developer ran agent sessions in a Linux VM on WSL 2. The VM's disk file filled the
small Windows drive under it. The VM remounted its disk read-only, and every session
stopped.

Inside the VM, `df` still showed lots of free space. It shows the disk file's virtual
size, not the free space on the Windows drive. So no agent saw the cause.

After a restart, a root process created the agent's temp folder first: `/tmp/claude-<uid>`
for Claude Code. Claude Code refuses a temp folder that another user owns. So every
session refused to start, and no agent could report why.

Doctor's road (record [0004](0004-the-road.md)) measures a project's practices. These
problems are about the machine, not the project.

## Decision

On 2026-10-20 the owner decided that doctor checks machine state that breaks agents
unseen. A check must meet four rules:

1. The agent can't see the problem from where it works.
2. Any stack can hit it.
3. It is read-only and cheap. A session stays within its time budget, and full doctor
   caps its time.
4. A step only the owner may take (sudo, moving disks, deleting data) is printed as a
   command, never run.

The six proposals, against these rules:

| Proposal | Decision |
|---|---|
| Free space on the host drive | Yes |
| A WSL disk file that can't shrink | Yes, as a hint on the host-drive note. The hint points to Microsoft's guide, not to a command: WSL marks its sparse mode unsafe, after reports of data corruption |
| Build outputs and caches across worktrees | Later, on top of the worktree notes of #365 |
| An agent temp folder owned by another user | Yes, in full doctor: the agent can't start, so the user runs `yokoten doctor` in a terminal |
| A half-written line in an agent's transcript | No: the transcript is the agent's private file. The guide's troubleshooting covers it |
| How fresh the backups are | No: backup tools differ. For code, pushing is the backup (#365, #366) |

These are notes in the `machine:` part, never stages, and never failures. Machine state
is not a stage of a project, and a note never changes the exit code.

The disk note warns when free space is under 20 GB and also under 10% of the disk. That
catches a 250 GB drive with nothing free, and stays quiet on a 2 TB drive with 150 GB free.
`YOKOTEN_MIN_FREE_GB` replaces both limits with one.

In WSL, full doctor finds the Windows drive through `reg.exe` and keeps the reading in
`~/.config/yokoten/machine.json`. A session runs no child process: it reads the repo's
own disk and repeats the kept reading.

## Options not taken

- **Make them stages on the road.** A stage is a practice a project takes up once. A
  full disk can come back any day, on any project.
- **Fail doctor on a full disk.** Doctor's exit code is about the project. A machine
  problem would fail CI and hooks for a reason the project can't fix.
- **Fix it for the user.** Deleting a root-owned folder needs sudo. Compacting a disk
  file needs Windows and a stopped VM. Both are the owner's call.
- **Read the host drive in every session.** `reg.exe` starts a Windows process. That costs
  too much at every session start, and it can hang.

## Consequences

- An agent that can't start gives no message. The guide tells the user to run
  `npx yokoten doctor` in a terminal.
- The temp folder's name comes from Claude Code's runtime file, so another agent's
  folder can join it there.
- A session hears about the Windows drive only after one full doctor has read it.
