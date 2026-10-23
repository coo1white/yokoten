<div align="center">

# yokoten · 横展

### AI does the thinking. yokoten is a program that guards the step from thinking to doing.

yokoten is a program, not an AI.
It cannot be talked out of a rule.
The same command gets the same answer every time, in under 100 ms, at no cost.
Every rule has a test.

It lives inside the AI coding tools you already use.
Before each command or edit, the tool asks yokoten.
You install it once, and there is nothing else to learn.
It works in a terminal, a desktop app, or an editor, and under tools that run many agents, such as Orca.
It does not replace those tools.

It is not an AI agent, not a chat tool, and not a team page.

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; English | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## What it does

yokoten protects five things: your work, your secrets, your releases, the code you run,
and the safeguard itself.

Some of that is on now. The guard stops a force push, a delete of `.git`, a tag push, a
package publish, a download piped into a shell, and a skipped commit check.
The commit check stops a secret in a commit. It needs `yokoten init` in the project.
The rest of the five protections come in v0.1.1.

The guard is invisible: it works when you type nothing.
A few commands are for you, such as `yokoten install` and `yokoten doctor`.
Team commands are planned for v0.1.2 ([issue #823](https://github.com/yokoten-labs/yokoten/issues/823)).

yokoten guards nine AI coding agents with the same rules: Claude Code, GitHub Copilot CLI,
Antigravity CLI, Codex CLI, Muse Code, DeepSeek Harness, Grok CLI, Gemini CLI, and OpenCode.
Seven are verified end to end. Gemini CLI and OpenCode are in the code but not run end to end.

When yokoten stops an action, a non-coder can act on the answer.
It says what was stopped, why, and what to do instead, then links the guide.

```
yokoten: git push origin v1.2.0 pushes a release tag. Only the owner decides when to release. If the owner asked for this, they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` (or your agent's command); do not look for another way.
  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules
```

## One engine, many safeguards

yokoten is a library of safeguards with one engine behind it.
The five protections are the first set of rules, and they come on for everyone in v0.1.1.
Each rule says three things: where it checks, what it looks for, and what it says when it stops an action.

The same rules hold at each checkpoint:

- between the AI and its coding tool, before a command or an edit runs;
- at a commit, and in CI, even when no agent is involved;
- later, between a sandbox and the internet, to see where data goes.

New kinds of safeguard can be added the same way: your project's own rules, and rules other projects share.
A lesson one project learns can protect every project.

## Install

You need [Node](https://nodejs.org/) 22.23.4 or later (24.22.1 or later on Node 24, 26.12.1
or later on Node 26). Nothing else.

```sh
npx yokoten install      # once per computer
cd your-project
npx yokoten init         # once per project
npx yokoten doctor       # where you are, and the one next step
```

In Claude Code you can use the plugin instead: `/plugin marketplace add yokoten-labs/yokoten`,
then `/plugin install yokoten@yokoten`. Use the plugin or `npx`, not both. For CI only,
[use it as a GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action).
The commit check asks for UTC commit times, so add `export TZ=UTC` to your shell profile once.

`npx skills add yokoten-labs/yokoten` copies the skills only: run `npx yokoten install`
too, or you get no command guard and no session doctor.

## What you see

An agent tries a force push. yokoten stops it, says why, and gives the fix. Then
`doctor` names the one next step:

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="A terminal. An agent runs git push --force origin main. The yokoten hook blocks it and says what happened, why, and the fix: use --force-with-lease. Then yokoten doctor shows stage 1 of 5 and names the next step: add tests.">

## Coming next

Team commands are planned for v0.1.2 ([issue #823](https://github.com/yokoten-labs/yokoten/issues/823)).
You will add, list, change, and remove agents, tasks, and machines from the command line.
A team page is a preview.
It is not part of the 0.1 releases.

## Works with

**Agents.** yokoten guards nine AI coding agents with the same rules: Claude Code, GitHub
Copilot CLI, Antigravity CLI, Codex CLI, Muse Code, DeepSeek Harness, Grok CLI, Gemini
CLI, and OpenCode. Seven are verified end to end. Gemini CLI and OpenCode are in the code
but not run end to end.
The [agent table](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)
says how each one was tested.

**Languages.** Your project can be in any language: the guard, the privacy and secrets
check, CI and the issue and pull request checks work the same in all of them. `doctor`
finds the test command for JavaScript and TypeScript, Python, Go, Rust, Java, .NET, Ruby,
PHP, Swift, Elixir, Dart, and any `make test`. For Go, Python, Rust, .NET,
Ruby and PHP, `init` writes the CI job that runs it.

## Why

On a good team, every change has a reason, a test and a review. Most people learn these
habits over years, often after something breaks. yokoten gives a newcomer the habits on
day one, one stage at a time, and its guard stops an AI agent before the worst mistakes.

No lesson stays in one project. *Yokoten* (横展) is a word from Toyota's factories: a fix
that one line finds goes to every line. When one project learns a lesson, yokoten offers
the check to every other project.

## On the road

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-dark.svg">
  <img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/road-light.svg" width="100%" alt="A road climbs a mountain past three stations: now, the hackathon, and next. Paths from other projects join it near the top. At the summit a flag marks the dream: anyone can build software the way good teams do.">
</picture>
</p>

The dream: anyone can build software the way good teams do.

| | Stage | Where it is |
|---|---|---|
| 1 | **Guard**: agents are stopped before a dangerous action | ✅ done |
| 2 | **Guide**: `doctor` walks a beginner through five stages; an agent drafts how an old project adopts yokoten | 🚧 now |
| 3 | **Team commands**: add, list, change, and remove agents, tasks, and machines from the command line | 🚧 planned for v0.1.2 ([issue #823](https://github.com/yokoten-labs/yokoten/issues/823)); a team page is a preview, not in the 0.1 releases |
| 4 | **The whole cycle**: from a short spec to build, test, review, release and upkeep | later |
| 5 | **Yokoten**: a lesson one project learns becomes a check, and the check spreads to every project | the goal |

Today's work is in the [issues](https://github.com/yokoten-labs/yokoten/issues) and
[milestones](https://github.com/yokoten-labs/yokoten/milestones).

## Learn more

- **[The guide](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md)**: the twelve rules, every command, how it works, and what it can't do.
- **[Decisions](https://github.com/yokoten-labs/yokoten/tree/main/docs/records)**: why it's built this way.
- **[Changelog](https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md)**, **[Contributing](https://github.com/yokoten-labs/yokoten/blob/main/CONTRIBUTING.md)**, **[Security](https://github.com/yokoten-labs/yokoten/blob/main/.github/SECURITY.md)**, **[Server setup](https://github.com/yokoten-labs/yokoten/blob/main/docs/server.md)**.

---

<p align="center"><sub>MIT · Built by <a href="https://coolwhite.us/">coolwhite</a> and a team of AI agents, with lessons from the factory floor.</sub></p>
