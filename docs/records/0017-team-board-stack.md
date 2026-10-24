# 0017 The team board: a local http interface, a plain page, then an app

Status: accepted
Date: 2026-10-22 (UTC)

## Context

The owner runs a team of agents across worktrees and pull requests. No one place
shows who works on what (#601). The owner picked the stack for the board on
2026-10-22: what serves the data, what shows it, and in what order the views ship.

## Decision

- **One small local interface serves the data.** Node's built-in `http`, in yokoten's
  own TypeScript, on 127.0.0.1 only. The page is only one view of it.
- **The first view is a plain page.** HTML, CSS and JavaScript, no framework, no new
  dependency. It refreshes every 15 seconds.
- **The terminal view ships with it.** `yokoten board --text` prints the same data.
- **An installable app comes before a desktop shell.** First a web app manifest, then
  a Tauri 2 shell. Not Electron.
- **The order is: page, actions, installable, Tauri.** The first version is read only.
  Agent control and Approve/Merge buttons are later issues.

## Options not taken

- **Electron for the desktop shell.** Heavier than Tauri 2; the owner picked Tauri 2.
- **A web framework for the page.** A framework is a dependency to install and keep;
  the page is small enough for plain HTML, CSS and JavaScript.
- **Buttons in the first version.** Approve stays on GitHub until the read-only board
  proves itself.

## Consequences

- The board works on Windows, macOS and Linux with nothing extra installed.
- Every view reads the same interface, so a new view changes no data code.
- The status file format is written down as an open format, so any vendor's agent can
  join by writing one file.
