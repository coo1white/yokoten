<div align="center">

# yokoten · 横展

[![ci](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml/badge.svg)](https://github.com/coo1white/yokoten/actions/workflows/yokoten.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-no%20build-3178C6?logo=typescript&logoColor=white)](docs/records/0002-typescript.md)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Claude Code](https://img.shields.io/badge/for-Claude%20Code-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)

**A guide for the journey. A guard at the bridge.**

One person and a few AI agents, building to a professional team's standard.<br/>
yokoten was built this way, and this repo is the example.

English | [中文](docs/zh-CN/README.md)

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

## Quick start

You need [Node](https://nodejs.org/) 22.18 or later. Nothing else.

```sh
git clone https://github.com/coo1white/yokoten
node yokoten/bin/yokoten.ts install                 # once per computer
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init      # once per project
```

Then open the project in Claude Code. It tells you what's still missing.

## Learn more

- **[The guide](docs/guide.md)**: the twelve rules, every command, how it works, and what it can't do.
- **[Server setup](docs/server.md)**: protect `main` and release tags on GitHub.
- **[Decisions](docs/records/)**: why it's built this way.

*Yokoten* (横展) is Toyota's word for rolling one line's fix out to every line.

---

MIT · Built by [coolwhite](https://coolwhite.us/), with lessons from the factory floor.
