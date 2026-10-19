<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" width="100%" alt="yokoten · 横展. A guide for the journey. A guard at the bridge. A road climbs through the mountains past five numbered stages to a bridge, where a lantern keeps watch.">
</picture>

<br/>

**Everyone can build software the way good teams do.**<br/>
yokoten guides you through a good team's habits, and guards your AI agents while you learn.

One person and a few AI agents built it that way: every issue, review, and release is in this repo.

**[yokoten.app](https://yokoten.app)** &nbsp;·&nbsp; English | [中文](docs/zh-CN/README.md) | [日本語](docs/ja/README.md)

<br/>

[![ci](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/yokoten-labs/yokoten/actions/workflows/yokoten.yml)
[![built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build-3178C6?logo=typescript&logoColor=white)](docs/records/0002-typescript.md)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Works with](docs/guide.md#works-with) Claude Code, Codex CLI and Gemini CLI.

</div>

## Why

On a good team, every change has a reason, a test and a review. Most people learn
these habits over years, often after something breaks. yokoten gives a newcomer the
habits on day one: plan, build, test, review, release, one stage at a time. Its guard
stops an AI agent before the worst mistakes, such as a force push, a test edited to
pass, or a private detail made public.

No lesson stays in one project. *Yokoten* (横展) is a word from Toyota's factories: a
fix that one line finds goes to every line. When one project learns a lesson, yokoten
offers the check to every other project.

## Install

You need [Node](https://nodejs.org/) 22.18 or later. Nothing else.

```sh
npx yokoten install      # once per computer
cd your-project
npx yokoten init         # once per project
npx yokoten doctor       # where you are, and the one next step
```

Before your first commit: commit with `TZ=UTC git commit`, or put `export TZ=UTC` in your
shell profile once. The commit check refuses other time zones, because a commit's time zone
tells strangers roughly where you live.

In Claude Code, you can use the plugin instead: `/plugin marketplace add
yokoten-labs/yokoten`, then `/plugin install yokoten@yokoten`. Use one way, not both.
Until the first release is on npm, [install from a clone](docs/guide.md#install-from-a-clone).
For CI only, [use it as a GitHub Action](docs/guide.md#use-it-as-a-github-action).

## What you see

An agent tries a force push. yokoten stops it, says why, and gives the fix. Then
`doctor` names the one next step:

<img src="docs/assets/demo.svg" width="680" alt="A terminal. An agent runs git push --force origin main. The yokoten hook blocks it and says what happened, why, and the fix: use --force-with-lease. Then yokoten doctor shows stage 1 of 5 and names the next step: add tests.">

## Where this is going

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/road-dark.svg">
  <img src="docs/assets/road-light.svg" width="100%" alt="A road climbs a mountain past three stations: now, the hackathon, and next. Paths from other projects join it near the top. At the summit a flag marks the dream: anyone can build software the way good teams do.">
</picture>
</p>

The guard is done. The guide is being built now. Next come more agents and hosts, then
the whole cycle. At the top is *yokoten*: what one project learns, every project gets.
The [roadmap](docs/guide.md#where-this-is-going) has the five stages. The
[board](https://github.com/orgs/yokoten-labs/projects/1) shows today's work.

## Learn more

- **[yokoten.app](https://yokoten.app)**: the site, with the guide and the records as pages.
- **[The guide](docs/guide.md)**: the twelve rules, every command, how it works, and what it can't do.
- **[Server setup](docs/server.md)**: protect `main` and release tags on GitHub.
- **[Decisions](docs/records/)**: why it's built this way.
- **[Contributing](AGENTS.md)**: the rules for working on yokoten.
- **[Security](.github/SECURITY.md)**: how to report a security problem.

---

<p align="center"><sub>MIT · Built by <a href="https://coolwhite.us/">coolwhite</a>, with lessons from the factory floor.</sub></p>
