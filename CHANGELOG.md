# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

### Added

- `yokoten bot -- <command>` runs one command (`gh`, `git push`) as the bot GitHub App,
  with a one-hour token made from the App's key. The token is never printed, and git
  cannot fall back to the owner's login. The dispatch skill now uses it (#4).

### Internal

- Claude Code's formats (tool-call input, settings and hooks, skill and agent paths)
  live in one adapter, `src/agents/claude-code.ts`, so another runtime is one sibling
  file. A test holds the module layers, another keeps the repo's `AGENTS.md` equal to
  the kit's, and CI also runs the tests on the oldest supported Node, 22.18.0 (#17).
- CI is one workflow, `yokoten.yml`, and main requires one check, `ci`, which fails
  if any other job fails or is cancelled. A new lint job runs actionlint and zizmor on
  the workflows. Actions are pinned to a commit, with the version in a comment, and a
  test holds that. Runs have time limits, checkout keeps no token, and a new push to a
  pull request cancels its old run. Dependabot waits a week before taking a release,
  and now also updates the kit's workflow (#36).

### Changed

- The CI workflow `init` writes is hardened: actions on the current versions, pinned
  to a commit with the version in a comment, a 10-minute time limit, no token left
  after checkout, and a new push to a pull request cancels its old run. Run `init`
  after deleting the old file to get it (#36).
- The README opens with what yokoten is for: one person and a few AI agents, building
  to a professional team's standard. It shows what changes on day one, and the road a
  project takes, stage by stage, with this repo as the example (#32).
- `init` no longer adds `CLAUDE.md`. Claude Code reads `AGENTS.md` when a project has
  none, so the one-line import was only clutter; a project that has one keeps it (#27).
- The repo root holds only files a tool looks for there. The Chinese README and guide
  are in `docs/zh-CN/`, and the security policy is in `.github/` (#27).
- yokoten is written in TypeScript, and Node runs it as it is: no build step, still no
  runtime dependencies. It needs Node 22.18 or later. Hooks, the vendored runtime and
  the machine copy run `bin/yokoten.ts`; `tsc` checks the types in CI (#9).

### Fixed

- Nothing yokoten prints shows the home folder, which names the machine's user:
  `install`, `doctor`, hook reasons and errors show it as `~`. Core rule 11 now covers
  output as well as the repo (#25).
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
