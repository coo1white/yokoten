# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

## [0.1.0] - 2026-10-24

The first release. yokoten guides you through a good team's habits, and guards your AI agents while you learn.
To start, read the [guide](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/guide.md).
The README is also in [中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-CN/README.md), [繁體中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-TW/README.md) and [日本語](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/ja/README.md).

### Added

**Stop risky agent actions**

- A guard checks each command and edit before it runs, and tells the agent why it stopped it.
- It stops release tag pushes, publish commands, force pushes and skipped commit checks.
- An agent fixing a bug can't edit the tests; a worker agent can't change the rules or CI, even from the shell.
- A project can block any program in `yokoten.json`, with its own reason.
- It runs in Claude Code, Codex, GitHub Copilot CLI, Antigravity CLI, Muse Code, DeepSeek Harness and Grok CLI.
- In Claude Code, Codex, Muse Code and Grok CLI, an agent must fix problems in its changed files before its turn ends.
- Agents see command output with your name, email, secrets and private hosts hidden by `yokoten redact`.
- The hooks start fast, and CI fails when one goes over its time budget.

**Check every commit**

- `yokoten check` runs before each commit and in CI, so a bad commit stops whoever made it.
- It catches personal emails, IP addresses and secrets, and names the file and line, never the text.
- When it stops a commit, it says how to take the stopped files out of it.
- A staged `node_modules` or other dependency folder is one finding, with the command that takes it out.
- Add your own private words, such as your name or city, to a list kept outside the repo.
- `yokoten install` adds your git name, git email and forge login to that list for you.
- `yokoten marks` counts your private words, and lets you add, remove or turn off a kind.
- A private word is found as a whole word, so `sam` stops `hi Sam` but not `sample`.
- A stopped line names the kind of private word, never the word, and how to let it through.
- A project can let its own name, public email or a mark through, in `yokoten.json` or on your machine only.
- `yokoten check --history` checks every old commit before a private repo goes public.

**Stop private details in what agents post**

- The guard runs the same checks on issues, pull requests, comments and release notes an agent posts with `gh`.
- It reads inline text, body files and heredocs, and refuses a body file it can't be sure of, with the reason.
- A read-only pipe after a post, such as `| tail -2`, is fine: the body is still checked.
- `yokoten bot -- gh pr create` checks the body before sending, adds the type and tier labels, and takes the linked issue's milestone.

**Know where you stand**

- `yokoten doctor` shows five stages, from a safety net to going public, and your one next step.
- Each new agent session hears that next step and why it matters.
- With the GitHub CLI (`gh`), `doctor` also reads your GitHub settings: branch rules, required reviews and security switches.
- On Gitea, GitLab and other hosts, `doctor` says which steps it can't check and what each asks.
- `doctor` names one way to run yokoten in every line, and each message tells you what to type next.
- `doctor` lists work that exists only on this machine, a low disk, and old temp folders, and only reads.
- `yokoten explain <id>` says what a rule means, and most problems link to the guide.

**Set up a project**

- Install yokoten as a Claude Code plugin, with `npx yokoten install`, or from a clone.
- `yokoten install` puts a `yokoten` command on your PATH, and `yokoten uninstall` removes it.
- `yokoten init` adds the rules, hooks, CI and templates to a project, and never overwrites your files.
- `init` keeps a project's own `AGENTS.md` and moves it under the core rules.
- `init` adds your package managers' folders, such as `node_modules/`, to `.gitignore`, and only adds missing lines.
- `init` updates a CI workflow you never changed, and keeps one you did.
- `init` writes a Dependabot config for your project's own packages, and a short CI for docs-only pull requests.
- A private repo can skip CI with `init --no-ci`.
- `yokoten adopt` drafts a plan for an older project: what it does today, and what to add.
- `yokoten update` brings a project's rules up to date with your yokoten.

**Learn from mistakes**

- `yokoten learn <issue>` turns an incident report into a draft check for a person to review.
- A reviewed check ships with yokoten, and `doctor` runs it in every project.
- `yokoten learn --upstream` keeps a note about a gap in yokoten itself, with your details hidden.

**Work with a team of agents**

- You talk to one lead agent; it hands each task to a worker agent in its own folder.
- Skills help agents hand out tasks, review changes, find root causes, record decisions and prepare releases.
- `yokoten bot` opens pull requests as a GitHub App, so you review work you did not write.

**Check pull requests in CI**

- Use yokoten as a GitHub Action: `uses: yokoten-labs/yokoten@<commit SHA>`.
- `yokoten check --pr` checks each pull request's title, description, linked issue and changelog entry.
- Problems show on the changed lines of the pull request, with how to fix them.
- A translation is flagged when only the English changed; a newer CI run on main cancels the older one.

[Unreleased]: https://github.com/yokoten-labs/yokoten/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yokoten-labs/yokoten/releases/tag/v0.1.0
