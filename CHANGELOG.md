# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

### Added

- yokoten installs as a Claude Code plugin: `/plugin marketplace add coo1white/yokoten`,
  then `/plugin install yokoten@yokoten`. The repo is the plugin and its marketplace. It
  uses the kit's skills and agents as they are, adds the same two hooks as `install`,
  and adds `/yokoten:init` and `/yokoten:doctor`. `git clone` and `install` still work.
  `doctor` counts an enabled plugin as the session hook, the runtime and the skills.
  `.claude-plugin/` is lead-only by default, in every project (#31).
- `check --pr` fails a pull request that changes a file CODEOWNERS owns unless its
  first line is `tier: A`. The paths set the lowest tier; the author can only raise it.
  It reads CODEOWNERS from the base branch, so a pull request can't lower its own tier.
  No CODEOWNERS file, no check. yokoten's own CODEOWNERS now lists only the paths where
  a mistake is hard to undo, and `doctor` no longer suggests `* @<you>`. **Kit change:**
  the pull request template says owned files are tier A (#97).
- A stop check for Claude Code: `yokoten hook --stop`. When the agent tries to end its
  turn, it checks the changed files (staged, not staged and new) for personal data,
  secrets and file rules. With findings, it sends the agent back once to fix them. It
  never sends it back twice in a row (`stop_hook_active`), and on an error the turn
  ends. **Kit change:** `init` now adds a Stop hook to `.claude/settings.json` (#92).
- `yokoten init --github` adds the standard labels (bug, feat, docs, refactor, ci,
  owner, incident, good first issue, hotfix) and a first milestone, through `gh`. Without
  `--yes` it only says what it would make. It keeps what is there and deletes nothing.
  `init` now refuses an unknown option (#10).
- The secret check catches Meta Model API keys (`LLM_` with an app id and a secret) (#68).
- A release flow for every project. `init` adds a `CHANGELOG.md` with an
  `[Unreleased]` section when the project has none. The new `release` skill picks the
  next version from the changelog, before 1.0 and after. It prepares the release pull
  request; only the owner creates the tag. Kit change: every project gets the changelog
  on its next `init`, and the skill on the next `install` (#34).
- Full `doctor` reads the server settings through `gh` and reports each as ok, missing
  or can't check: the rules on the default branch, the required CI check, code owner
  review, squash only, delete branch on merge, the tag ruleset on `v*` and the security
  switches. It notes branches with no open pull request. It only reads, and never
  changes a setting. When `gh` is missing, signed out or refused, it says how to fix
  that and goes on. A missing setting makes `doctor` exit 1 (#7).

### Changed

- `doctor --json` gives `server` as a list of `{ id, mark }` (it was a list of text) (#7).
- The pull request check counts `Part of #N` as a linked issue. Only `Closes`, `Fixes`
  and `Resolves` close it (#82).
- The CI workflow `init` writes has one required check, `ci`. It waits for every other
  job and fails if one of them fails. A new `lint` job runs actionlint and zizmor on the
  workflows. Each job gets only the permissions it names. Make `ci` the required check
  in place of `check`. Delete the old file and run `init` again to get it (#36).
- yokoten's own CI tests on Node 22.18.0 and 24 on Linux, and on Node 24 on macOS. A
  test holds that `ci` waits for every job and that checkout keeps no token (#36).
- Every message has three parts: what happened, why it matters, and the fix. Most
  lines keep their words and gain the missing part. Some are reworded. A full folder
  reads `docs/: 9 entries, over the cap of 7: ...` (was `docs/ has 9 entries ...`). A
  pull request problem reads `title: not in the commit form. ... Use ...`. The force push
  message names the flag, and a long-sentence note gains its fix (#42).
- An unknown option to `check`, `doctor`, `hook` or `explain` is refused with exit 1;
  it used to be ignored. So are two of `--staged`, `--history` and `--pr` together,
  where one used to win quietly. Exit codes are unchanged: 0 ok, 1 problems or a usage
  error, 2 the hook blocked (#42).
- `doctor` is a guide along the road in five stages (record 0004). A session hears
  three lines: the stage, the one next step, and why. Full `doctor` shows every stage
  and step as done, next, to do, not now or can't check. The stage is worked out each
  time, never saved, and the existing "not now" keys still work. New local steps:
  templates, changelog, titles, codeowners, bot and security-files. The `github` layer
  is now `host`, with `src/host/github.ts` as the first adapter (#33).

### Added

- Issue titles have a standard: `area: verb phrase` for a task, `area: symptom` for an
  incident, at most 60 characters, no full stop and no `#N`. `check --issue` checks it
  in CI, and the new `issue` workflow runs it when an issue is opened or edited; it only
  reads. The issue templates start the title with `area: `. `"areas"` in
  `yokoten.json` limits the areas, for issue titles and for pull request titles. Kit
  change: every project gets the workflow and the templates on its next `init`.
- `--json` on `check`, `doctor`, `hook` and `explain`: pure JSON on stdout, for an
  agent or a script. Each finding has `id`, `what`, `why`, `fix`, and `file` and
  `line` when it is in a file; no field holds a private value. The guide's new "Exit
  codes" section writes the codes down once (#42).
- `yokoten explain <id>`: a rule or a step on the road, its reason and how it is
  checked. An unknown id exits 1 with the list of ids (#42).
- Full `doctor` names the outside standard each step meets, when there is one: OpenSSF
  Scorecard, the Best Practices badge, OSPS Baseline, Conventional Commits, for example
  `ci (Scorecard: CI-Tests)`. The session message stays three lines (#58).
- The commit check refuses build output (a file in a `dist/`, `build/` or `out/`
  folder) and binary files. Images and fonts pass, and `allowBuild` in `yokoten.json`
  lets other paths through. A new `no-build-output` step in stage 2 of the road looks
  for such files already in the repo. Kit change: every project gets this check on its
  next `init` (#56).
- A `tests` step in stage 1 of the road: the project has a test command (a `test`
  script in package.json, or a test runner such as `node --test` or `go test`), and a
  workflow in `.github/workflows` runs it (#55).
- `check --pr` notes a pull request that changes more than 400 lines (added plus
  deleted; binary and lock files not counted): smaller pull requests are easier to
  review. A note, never a failure (record 0004, #57).
- A pull request standard, checked in CI by `yokoten check --pr` (its own `pr` workflow,
  so editing the title or labels reruns it): a commit-form title of at most 72
  characters, a `tier: A/B/C` first line (how hard a mistake is to take back), Why /
  What changed / How tested, a linked issue, a changelog line when behaviour changes,
  a milestone and labels. Long sentences in changed Markdown are notes, never failures
  (plain English, record 0005). Kit change: projects get the workflow and the new
  template on their next `init`, and `AGENTS.md` gains a Writing section (#47, #49).
- `yokoten bot -- <command>` runs one command (`gh`, `git push`) as the bot GitHub App,
  with a one-hour token made from the App's key. The token is never printed, and git
  cannot fall back to the owner's login. The dispatch skill now uses it (#4).
- Kit change: `init` now gives every project `.github/dependabot.yml` (the actions CI
  runs, monthly, one pull request, releases a week old) and `.github/SECURITY.md` (report
  privately). It keeps a project's own copies. `doctor` adds the security switches to
  the owner's last server step: private vulnerability reporting, secret scanning with
  push protection, and Dependabot alerts (#35).
- The privacy check (commit, CI and `check --history`) also catches secrets: GitHub,
  npm, Slack, Stripe live, Google, OpenAI and Anthropic tokens, AWS access key ids,
  and PEM private keys. A hit names the kind, never the secret, and doctor's self-test
  feeds it a sample (#8).
- `install` also writes every skill to `~/.agents/skills`, the open Agent Skills folder
  that Codex, Gemini CLI, Copilot, Cursor and others read, next to `~/.claude/skills`.
  `doctor` wants each skill in both and names what is missing. Agents stay Claude-only
  (#29).
- The tool-call guard for Codex and Gemini CLI. `yokoten hook --agent codex` reads a
  Codex PreToolUse call (a shell command, or the files an `apply_patch` touches);
  `--agent gemini` reads a Gemini CLI BeforeTool call (`run_shell_command`,
  `write_file`, `replace`). Without `--agent`, it reads Claude Code's call as before.
  **Kit change:** `init` now also writes `.codex/hooks.json` and `.gemini/settings.json`
  (keeping what is in them), and `.codex/**` and `.gemini/**` are lead-only by default.
  `doctor` reports the two hooks but does not count them as missing yet: a real block in
  each tool is still to be seen (#30).

### Internal

- Code is `.ts` only: a test fails on any `.js`, `.mjs`, `.cjs` or `.tsx` under `bin/`,
  `src/` or `test/`, since Node runs `.ts` with no build (#43).
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

- Outside a repo, the tool-call guard no longer prints git's own error. An agent read it as the
  result of the command the guard stopped. The release message now gives the value:
  `YOKOTEN_RELEASE_APPROVAL=1 claude` (#100).
- Commits no longer record the machine's time zone, which narrows down where the owner
  lives. The commit check refuses a commit whose time is not UTC (and says how to fix
  it, never printing the offset); `init` sets `TZ=UTC` for agent sessions; `check
  --history` counts older commits with a time zone as a note. A project can turn it off
  with `privacy.utc: false` (#40).
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
