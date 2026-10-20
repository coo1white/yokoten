# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Dates are UTC.

## [Unreleased]

## [0.1.0] - 2026-10-24

The first release. yokoten guides you through a good team's habits, and guards your AI agents while you learn.
To start, read the [guide](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/guide.md).
The README is also in [简体中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-CN/README.md), [繁體中文](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/zh-TW/README.md) and [日本語](https://github.com/yokoten-labs/yokoten/blob/v0.1.0/docs/i18n/ja/README.md).

### Added

**Stop risky agent actions**

- A guard checks each command and edit before it runs, and tells the agent why it stopped it.
- It stops release tag pushes, publish commands, force pushes and skipped commit checks.
- An agent fixing a bug can't edit the tests; a worker agent can't change the rules or CI.
- A project can block any program in `yokoten.json`, with its own reason.
- It runs in Claude Code, Codex, GitHub Copilot CLI, Antigravity CLI, Muse Code and DeepSeek Harness.
- In Claude Code, Codex and Muse Code, an agent must fix problems in its changed files before its turn ends.

**Check every commit**

- `yokoten check` runs before each commit and in CI, so a bad commit stops whoever made it.
- It catches personal emails, IP addresses and secrets, and names the file and line, never the text.
- Add your own private words, such as your name or city, to a list kept outside the repo.
- `yokoten check --history` checks every old commit before a private repo goes public.

**Know where you stand**

- `yokoten doctor` shows five stages, from a safety net to going public, and your one next step.
- Each new agent session hears that next step and why it matters.
- With the GitHub CLI (`gh`), `doctor` also reads your GitHub settings: branch rules, required reviews and security switches.
- `yokoten explain <id>` says what a rule means, and most problems link to the guide.

**Set up a project**

- Install yokoten as a Claude Code plugin, with `npx yokoten install`, or from a clone.
- `yokoten init` adds the rules, hooks, CI and templates to a project, and never overwrites your files.
- `yokoten adopt` drafts a plan for an older project: what it does today, and what to add.
- `yokoten update` brings a project's rules up to date with your yokoten.

**Learn from mistakes**

- `yokoten learn <issue>` turns an incident report into a draft check for a person to review.
- A reviewed check ships with yokoten, and `doctor` runs it in every project.

**Work with a team of agents**

- You talk to one lead agent; it hands each task to a worker agent in its own folder.
- Skills help agents hand out tasks, review changes, find root causes, record decisions and prepare releases.
- `yokoten bot` opens pull requests as a GitHub App, so you review work you did not write.

**Check pull requests in CI**

- Use yokoten as a GitHub Action: `uses: yokoten-labs/yokoten@<commit SHA>`.
- `yokoten check --pr` checks each pull request's title, description, linked issue and changelog entry.
- Problems show on the changed lines of the pull request, with how to fix them.

[Unreleased]: https://github.com/yokoten-labs/yokoten/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yokoten-labs/yokoten/releases/tag/v0.1.0
