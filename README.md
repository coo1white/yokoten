<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" width="100%" alt="yokoten · 横展. A guide for the journey. A guard at the bridge. A road climbs through the mountains past five numbered stages to a bridge, where a lantern keeps watch.">
</picture>

<br/>

One person and a few AI agents, building to a professional team's standard.<br/>
yokoten was built this way, and this repo is the example.

**[yokoten.app](https://yokoten.app)** &nbsp;·&nbsp; English | [中文](docs/zh-CN/README.md)

<br/>

[![ci](https://img.shields.io/github/actions/workflow/status/coo1white/yokoten/yokoten.yml?branch=main&label=ci&style=flat&labelColor=1c1a16&color=9e3620)](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml)
[![works with 3 agents](https://img.shields.io/badge/works%20with-3%20agents-9e3620?style=flat&labelColor=1c1a16)](docs/guide.md#install-and-commands "Claude Code, Codex, Gemini CLI")
[![dependencies 0](https://img.shields.io/badge/dependencies-0-9e3620?style=flat&labelColor=1c1a16)](package.json)
[![TypeScript, no build](https://img.shields.io/badge/TypeScript-no%20build-9e3620?style=flat&logo=typescript&logoColor=f4f0e6&labelColor=1c1a16)](docs/records/0002-typescript.md)
[![license MIT](https://img.shields.io/badge/license-MIT-9e3620?style=flat&labelColor=1c1a16)](LICENSE)

</div>

## What changes on day one

| Your agent tries to… | Without yokoten | With yokoten |
|---|---|---|
| force-push, or tag a release | it happens | stopped before it runs, and told why |
| "fix" a failing test by editing the test | the test passes, the bug stays | not allowed in a fix |
| commit your email, a server IP, your city | it goes public | the commit stops; the report names the file and line, never the text |
| open a pull request | as you, with all your rights | as a bot; nothing merges without you |
| work in another project | starts from zero | hears what that project is missing, and offers to set it up |

When it stops something, the agent reads a reason, not just "no":

```
yokoten: git push --tags pushes tags. Only the owner decides when to release.
```

## The road

Software teams work in a loop: plan, build, check, review, release. yokoten takes you
along it one stage at a time. Every stage is something this repo already does, so you
can see it working:

| Stage | You learn | See it here |
|---|---|---|
| **1 · Safety net** | rules the agents read, checks that stop them | [AGENTS.md](AGENTS.md) |
| **2 · Issues and pull requests** | every change has a reason; CI passes before it merges; labels, milestones, a board | [issues](https://github.com/coo1white/yokoten/issues?q=is%3Aissue), [pull requests](https://github.com/coo1white/yokoten/pulls?q=is%3Apr), [the board](https://github.com/users/coo1white/projects/1) |
| **3 · Release** | clear commit messages, a changelog, version numbers | [CHANGELOG.md](CHANGELOG.md) |
| **4 · A team of agents** | a bot, workers, a reviewer; you stay the boss | [the guide](docs/guide.md#managing-agents-like-a-team) |
| **5 · Going public** | a privacy check over all history, security settings, protected branches | [security policy](.github/SECURITY.md) |

## Where this is going

**The dream: everyone can build software the way good teams do.** Someone new to
programming should start on the right road on day one and walk it safely with AI agents.
Software development has a full cycle (the SDLC: plan, build, test, review, release,
maintain). yokoten teaches that cycle by doing it, one step at a time.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/road-dark.svg">
  <img src="docs/assets/road-light.svg" width="100%" alt="Five stations on one road. The first is done, the second is where we are now, and three are ahead. From the last one, the road branches out.">
</picture>
</p>

| Stage | Name | What it means | Now |
|---|---|---|---|
| 1 | **Guard** | AI agents are stopped before a dangerous action: a force push, a test edited to pass, a private detail leaked | ✅ done |
| 2 | **Guide** | a beginner walks the five stages with `doctor`, one thing at a time; an agent reads an old project and drafts how to adopt yokoten | 🚧 now, around the hackathon |
| 3 | **Any tool, any host** | Claude Code, Codex, Gemini CLI and Muse Code keep the same rules; GitHub, Gitea and GitLab all work | next |
| 4 | **The whole cycle** | from a short spec to build, test, review, release and maintenance, the full SDLC has a guide | later |
| 5 | **Yokoten** | a lesson one project learns becomes a check, and the check spreads to every project. What one person learns, everyone gets | the goal |

The word *yokoten* (横展) comes from Toyota's factories. A lesson learned on one line is
spread across every line. That is where the name comes from.

The near steps are in [M0](https://github.com/coo1white/yokoten/milestone/1) and
[M1](https://github.com/coo1white/yokoten/milestone/2); the [board](https://github.com/users/coo1white/projects/1) shows what is being built today.

## Quick start

You need [Node](https://nodejs.org/) 22.18 or later. Nothing else.

```sh
git clone https://github.com/coo1white/yokoten
node yokoten/bin/yokoten.ts install                 # once per computer
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init      # once per project
```

Then open the project in Claude Code. It tells you which stage you are at, and the one
next step.

## Learn more

- **[The guide](docs/guide.md)**: the twelve rules, every command, how it works, and what it can't do.
- **[Server setup](docs/server.md)**: protect `main` and release tags on GitHub.
- **[Decisions](docs/records/)**: why it's built this way.

---

<p align="center"><sub>MIT · Built by <a href="https://coolwhite.us/">coolwhite</a>, with lessons from the factory floor.</sub></p>
