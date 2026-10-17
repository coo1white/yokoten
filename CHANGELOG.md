# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

### Internal

- Claude Code's formats (tool-call input, settings and hooks, skill and agent paths)
  live in one adapter, `src/agents/claude-code.ts`, so another runtime is one sibling
  file. A test holds the module layers, another keeps the repo's `AGENTS.md` equal to
  the kit's, and CI also runs the tests on the oldest supported Node, 22.18.0 (#17).

### Changed

- yokoten is written in TypeScript, and Node runs it as it is: no build step, still no
  runtime dependencies. It needs Node 22.18 or later. Hooks, the vendored runtime and
  the machine copy run `bin/yokoten.ts`; `tsc` checks the types in CI (#9).

### Fixed

- The privacy check no longer flags addresses that point at no person: role inboxes at
  public services (`support@github.com`), SSH remotes at public forges
  (`git@gitlab.com:owner/repo`), GitLab noreply addresses and `.local` names. A personal
  address at the same domains, and an SSH remote at a private host, are still caught (#11).
- The tool-call hook now applies file rules when the repo path goes through a symlink
  (on macOS, every path under `/var`). Before, such an edit was treated as outside the
  repo and let through (#1).

## [0.1.0] - 2026-10-18

### Added

- `yokoten hook`: a tool-call guard for Claude Code. Stops release tag pushes, release
  and publish commands, plain force pushes and skipped commit checks; stops test edits
  in a fix task and lead-only file edits by a worker.
- `yokoten check`: the commit check (lead-only files, fix-task test files, layout,
  privacy), for the tree, the next commit (`--staged`) or every commit (`--history`).
- A privacy check: personal email and IP addresses, plus a private-marks list kept
  outside the repo. Hits are reported without echoing the mark.
- `yokoten doctor`: what a project and machine are missing, with a self-test that feeds
  every check a known-bad input first. `--session` for the start of every session.
- `yokoten init` and `yokoten install`: put the practices into a project and a machine,
  adding files and never overwriting.
- The kit: twelve core rules in `AGENTS.md`, five skills (`yokoten`, `dispatch`,
  `inspect`, `rca`, `record`), three agents (`worker`, `reviewer`, `verifier`), CI,
  issue and pull request templates.

[Unreleased]: https://github.com/coo1white/yokoten/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/coo1white/yokoten/releases/tag/v0.1.0
