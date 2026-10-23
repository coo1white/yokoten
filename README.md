<div align="center">

# yokoten · 横展

### Every AI agent. One set of rules.

AI made writing code cheap, not managing it. yokoten holds every agent to your rules,
from any vendor, and shows the whole team on one board. You make the calls.

yokoten is to AI-written code what UL certification is to electrical appliances: it
doesn't build the product, it holds every maker to the same safety rules.

**[yokoten.app](https://yokoten.app/?from=github)** &nbsp;·&nbsp; English | [简体中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-CN/README.md) | [繁體中文](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/zh-TW/README.md) | [日本語](https://github.com/yokoten-labs/yokoten/blob/main/docs/i18n/ja/README.md)

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/yokoten-labs/yokoten/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/yokoten?logo=npm)](https://www.npmjs.com/package/yokoten)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.23.4-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>

## What it does

yokoten adds three things on top of the agents you already use. It uses each agent's own
hooks, sandbox and settings, and doesn't replace them.

1. **One set of rules for every agent.** A guard checks each command and edit before it
   runs. It stops a force push, a release tag, a skipped commit check, a test edited in a
   fix task, and a secret or private detail in what an agent posts. It tells the agent why
   and what to do instead.
2. **The rules, in each agent's own language.** `yokoten init` writes the hooks for each
   agent it supports, and the sandbox settings for Claude Code, Codex, Gemini CLI and Grok.
   The commit check and CI stop a bad change even when no agent is involved.
3. **A board for a team of agents.** Agents from different vendors work side by side,
   each in its own fenced desk, and you see all of them on one page.

yokoten works before the pull request and alongside [PR review bots](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#review-bots-you-will-see-on-pull-requests).

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
then `/plugin install yokoten@yokoten`. Use the plugin or `npx`, not both.
Choose [which version to install](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#which-version-to-install):
Stable (the default), Beta or Dev. For CI only,
[use it as a GitHub Action](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#use-it-as-a-github-action).
The commit check asks for UTC commit times, so add `export TZ=UTC` to your shell profile once.

`npx skills add yokoten-labs/yokoten` copies the skills only: run `npx yokoten install`
too, or you get no command guard and no session doctor.

## What you see

An agent tries a force push. yokoten stops it, says why, and gives the fix. Then
`doctor` names the one next step:

<img src="https://raw.githubusercontent.com/yokoten-labs/yokoten/main/docs/assets/demo.svg" width="680" alt="A terminal. An agent runs git push --force origin main. The yokoten hook blocks it and says what happened, why, and the fix: use --force-with-lease. Then yokoten doctor shows stage 1 of 5 and names the next step: add tests.">

## Run a team of agents

yokoten is built by such a team: a lead agent plans and reviews, and engineers from
different vendors each take one issue.

- **A desk for each engineer.** `yokoten desk` starts an agent in its own clone, with no
  network but its own API, no tokens, and your home folder hidden. It can't push, and it
  can't change the rules it works under.
- **A bot opens the pull requests.** Every pull request says how risky it is (tier A, B
  or C). The risky ones wait for your approval; checks must be green before anything merges.
- **One board.** `yokoten board` serves a page on your machine: every agent and what it
  is doing, each pull request as Built, Checked, You (tier A only), Merged, and what needs you. It works
  on a phone, in four languages, and loads nothing from the internet.

The board and the desk are on `main` and come to npm with the next release.

## Works with

**Agents.** The guard runs in Claude Code, Codex CLI, GitHub Copilot CLI, Antigravity CLI,
Muse Code, DeepSeek Harness and Grok CLI. Gemini CLI is listed but not verified end to end.
The [agent table](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#works-with)
says how each one was tested.

**Languages.** Your project can be in any language: the guard, the privacy and secrets
check, CI and the issue and pull request checks work the same in all of them. `doctor`
finds the test command for JavaScript and TypeScript, Python, Go, Rust, Java, .NET, Ruby,
PHP, Swift, Elixir, Dart and any `make test`, and for Go, Python, Rust, .NET,
Ruby and PHP `init` writes the CI job that runs it.

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
| 3 | **A team, any tool, any host**: agents from every vendor under one set of rules and one board; GitHub, Gitea and GitLab | 🚧 the team board now, around the Meta hackathon; Windows and Gitea next |
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
