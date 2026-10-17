# The yokoten guide

The [README](../README.md) is the short version. This is everything else: why yokoten exists, how it works, the rules, the commands, and what it can't do.

## Words used here

- **Session**: one conversation with an AI coding agent, such as Claude Code.
- **Hook**: a small program the agent's tool runs at a set moment. yokoten adds one that
  runs before every command or edit (and can stop it), and one at the start of each
  session.
- **Commit check**: a git hook (`.githooks/pre-commit`) that runs before each commit.
- **CI**: the checks GitHub runs on every pull request.
- **Ruleset**: a GitHub setting that protects a branch or tag, for example "no merge
  without review".
- **Owner, lead, worker**: you; the agent session you talk to; a session the lead starts
  for one task. See [Managing agents like a team](#managing-agents-like-a-team).

## The name

*Yokoten* (横展) is a word from Toyota's shop floors. When one line finds a fix for a
defect, the fix is rolled out to every line that could have the same defect, not just
the line that found it. This repo does that for software built with AI coding agents.

## The problem

You run a project with AI agents for a few months. You learn things the hard way: an
agent "fixes" a failing test by changing the test, a pull request merges with a commit
nobody reviewed, a server address ends up in a tracked file. You add a rule, a hook, a
check. That project gets better.

Then you start a new project, or go back to an old one, and none of it is there. The
lessons live in one repo and in your head. If you forget to ask for them, the agent
starts from zero.

yokoten turns those lessons into something that checks itself:

- **Rules with reasons.** Twelve core rules. Each one says why it exists (an incident,
  or a risk if nothing has gone wrong yet) and which check holds it. A rule without a
  check is a wish.
- **Guards that run on their own.** A tool-call hook stops an agent before a bad
  command runs. A commit check catches what the hook can't see. CI runs the same
  check for commits made without either.
- **A reminder you don't have to remember.** Every session starts with `doctor`. It
  tells the agent the project's stage on the road, and the one next step. The agent
  brings it up, so you don't have to.

## Three checks and a lock

```mermaid
flowchart LR
  A["agent runs a command<br/>or edits a file"] --> H{{"1 · tool-call hook"}}
  H --> C["commit"] --> K{{"2 · commit check"}}
  K --> P["pull request"] --> I{{"3 · CI"}}
  I --> R{{"lock · your review"}} --> M["main"]
```

| | Runs | Stops |
|-|------|-------|
| **1** | before each tool call | tag pushes, force pushes, skipped checks; test edits in a fix task; a worker editing the rules |
| **2** | on every commit | what the hook can't see: files changed by `sed` or a script, personal data, an overfull folder |
| **3** | on every pull request | a commit made with the hook off |
| **lock** | on the server | a merge without your review, a push to `main`, a release tag that isn't yours |

## What a session sees

At the start of a session in a project that hasn't adopted yokoten yet:

```
yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.
Why: an agent follows the rules it can read, and only those.
Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).
```

The session hears about one step only: the stage, the next step, and why it matters.
The stage is worked out from the files each time; nothing saves it. A step you marked
"not now" is skipped. The order is advice: a later step done early counts as done.
When every step is done or "not now", the session hears one line that says so.
The agent tells you in your own language. yokoten prints English, which agents read most
reliably.

`yokoten doctor` shows the whole road. Each step is **done**, **next**, **to do**, **not
now** (with your reason) or **can't check**. Steps that yokoten can't check yet are not
listed:

| Stage | Steps |
|---|---|
| **1 · Safety net** | `rules`, `tool-hook`, `commit-check`, `runtime` |
| **2 · Issues and pull requests** | `ci`, `issues` (no todo file), `templates` |
| **3 · Release** | `changelog`, `titles` (CI runs `check --pr`) |
| **4 · A team of agents** | `codeowners`, `bot`, `skills` |
| **5 · Going public** | `security-files` (a security policy, Dependabot, a license) |

[Record 0004](records/0004-the-road.md) says why the road looks like this.

And when an agent tries to push a release tag:

```
yokoten: git push --tags pushes tags. Only the owner decides when to release. If the owner asked for this, they start the session with YOKOTEN_RELEASE_APPROVAL set.
```

## Four layers

| Layer | What | How |
|-------|------|-----|
| **Machine** | Skills, agents, and two user-level hooks, the same on every computer | `yokoten install` |
| **Project** | Rules, the commit check, the tool-call hook, CI, issue and PR templates, Dependabot (monthly, one pull request), a security policy | `yokoten init`, then the `yokoten` skill for an old project |
| **Server** | Branch and tag rulesets, squash merge, code owners, a bot with limited rights, the security switches | Set once by the owner; `doctor` lists the steps |
| **Rules** | `AGENTS.md`: twelve core rules, plus the project's own | Every rule names its check |

An old project isn't a blank slate. Some of its habits are better than ours. So the
`yokoten` skill goes through the practices one at a time with you, and each one gets a
decision: **as-is**, **lighter** (and what's left out), or **not now** (with the reason
and when to look again). "Not now" goes into `yokoten.json`, and `doctor` stops asking.

### A first draft of the table

`yokoten adopt` drafts that table before the talk starts. It reads the project's files
and says what the project does today for each step: **done**, **missing** or
**partial**. Partial means the project has its own way, such as husky hooks, or a CI
that doesn't run yokoten. A model then proposes a decision and a one-sentence reason
for each row.

- The model gets only those short facts. It never gets file contents.
- yokoten runs its privacy check on the request first. On a hit, it sends nothing.
- With no key, a failed call or a bad answer, rules draft the table instead: done or
  missing is as-is, partial is lighter. The output says which one drafted it.
- `adopt` never writes a file. You still decide every row.

The model runs on Meta's model API (the Llama API), through its OpenAI-compatible
endpoint. Set `LLAMA_API_KEY` to your key. `LLAMA_API_BASE` and `LLAMA_MODEL` point it at any
other OpenAI-compatible endpoint and model.

## Install and commands

Requires Node 22.18 or later, which runs TypeScript as it is. No build step, no
dependencies.

```sh
git clone https://github.com/coo1white/yokoten
node yokoten/bin/yokoten.ts install      # this machine: skills, agents, hooks
cd your-project
node ~/.local/share/yokoten/bin/yokoten.ts init     # this project: adds files, never overwrites
node ~/.local/share/yokoten/bin/yokoten.ts doctor   # the road: where you are, what's next
```

`init` copies the runtime into `.yokoten/` in your project. Commit it: the hooks and CI
then run with no network and no global install.

`init` also puts two safe defaults in `.github/`:

- `dependabot.yml` updates the actions that CI runs. It opens one pull request a month,
  and takes a release only when it is a week old. A comment in the file shows how to
  add your own packages (npm, pip, Go) the same way.
- `SECURITY.md` asks people to report a vulnerability privately, not in a public issue.
  For this, turn on private vulnerability reporting. `doctor` lists it with the other
  security switches.

| Command | What it does |
|---------|--------------|
| `install` | Skills into `~/.claude/skills` and `~/.agents/skills`, agents into `~/.claude/agents`, a SessionStart `doctor` hook, a user-level command guard, and an empty private-marks file |
| `init [dir]` | Puts the practices into a project. Adds files; keeps any that are already there and says so |
| `doctor [--session]` | The road: every stage and step, and what this machine is missing. `--session` prints only the next step, for the start of a session |
| `adopt [--json]` | A draft of the adoption table for an old project: what it does today, and a proposed decision for each step. `--json` prints the rows. Writes nothing |
| `check [--staged]` | Layout, privacy and lead-only files, for the tree or the next commit |
| `check --pr` | In CI: the pull request's title, `tier:` line, sections, linked issue, changelog line, milestone and labels. Long sentences in changed Markdown, and a diff over 400 changed lines, are notes |
| `check --history` | The privacy check over every commit on every branch. Run it before a private repo goes public |
| `hook [--agent <name>] [--commands-only]` | The tool-call guard. Reads one tool call on stdin: a Claude Code PreToolUse call by default, a Codex PreToolUse call with `--agent codex`, a Gemini CLI BeforeTool call with `--agent gemini` |
| `bot -- <command>` | Runs one command (`gh`, `git push`) as the bot, with a one-hour token it never prints. Setup: [server.md](server.md#3-the-bot-a-github-app) |


## The core rules

The full table, with the reasons, is in [`kit/project/AGENTS.md`](../kit/project/AGENTS.md).

1. Every piece of work starts as an issue. No todo files.
2. Nothing reaches `main` without a pull request and green CI.
3. Only the owner creates tags and releases.
4. A fix task changes code, never tests.
5. A worker doesn't change lead-only files: the rules, agent config, hooks, CI.
6. Never skip the commit check.
7. No plain force push. Never rebase a shared branch.
8. Squash merge. One pull request, one purpose; small polish goes in one batch.
9. Review and test the exact commit that merges.
10. No folder holds more than 7 entries.
11. Nothing in the repo, or in what yokoten prints, points at a person or holds a secret.
12. Decisions are written down once and kept. Facts are replaced. Times are UTC.

## Managing agents like a team

The setup treats agents like staff on a line, each with a clear role and limited rights:

- **The owner** (you) decides what gets built and when it ships. Only you approve pull
  requests, create release tags, and change repo settings.
- **The lead** is the session you talk to. It plans, splits the work, reviews, and opens
  pull requests through a **bot**, never with your account.
- **Workers** are sessions the lead starts for one task each, in their own worktree,
  with `YOKOTEN_ROLE=worker`. They change code and report back. They never push.
- **The bot** is a GitHub App installed on the repo. It can open pull requests but has
  no Workflows permission, so it can't change the CI that checks it. A ruleset requires
  your review, so nothing it opens merges without you.

Five skills carry the method: `dispatch` (brief a worker), `inspect` (review one exact
commit in three passes), `rca` (root cause, a check, then spread it), `record` (write
decisions down), and `yokoten` (adopt the practices). Three agents do the work:
`worker`, `reviewer` (reads only), and `verifier` (runs, never fixes).

Server setup, step by step: [`docs/server.md`](server.md).

## Privacy

Rule 11 has a check. It scans for personal email addresses and IP addresses, in CI and
on every commit. On your own machine it also reads `~/.config/yokoten/private-marks`:
your name, your city, your domains, your server names. That file stays outside the
repo, because a list of what must not be published can't itself be published. A hit
is reported by file and line; the mark itself is never printed.

The same check catches secrets: GitHub, npm, Slack, Stripe, Google, OpenAI and
Anthropic tokens, AWS access key ids, and PEM private keys. A hit names the kind of
secret, never the secret. Deleting it is not enough, since git keeps it: rotate it.

A commit also records the time it was made, with your time zone, and a time zone
narrows down where you live. So the commit check asks for UTC: `init` sets `TZ=UTC` for
agent sessions, and for your own commits it tells you how.

## What it doesn't do

Honest limits:

- **The guards read command text.** A command assembled in pieces gets past them.
  They catch mistakes and drift; they aren't a lock. The lock is on the server: branch
  protection, code owners, and a bot without the rights to release or change CI.
- **Server settings aren't checked yet.** `doctor` lists the three steps for the owner.
  Checking them through the API is planned.
- **Claude Code first.** Agents and the user-level hooks follow Claude Code's formats.
  Skills are the open SKILL.md format, so `install` also puts them in `~/.agents/skills`,
  where Codex, Gemini CLI, Copilot, Cursor and other agents find them. The tool-call
  guard also runs in Codex and Gemini CLI: `init` writes `.codex/hooks.json` and
  `.gemini/settings.json`, and each tool asks you once to trust the hook. Nobody has yet
  seen a real Codex or Gemini CLI session blocked by it (#30), so `doctor` reports those
  two hooks but does not count them as missing. The rules are plain `AGENTS.md`, which
  Claude Code reads when a project has no `CLAUDE.md`, and so do most other agents. Muse
  Code's skills and hooks are planned.

## What was left out on purpose

These came from the same projects and worked there, but cost more than they saved for
a general kit: a check that every commit's type matches the files it touches; byte-level
replay of merges in the queue; a folder taxonomy for todo files; a 978-line rules file;
signed release verdicts committed to the repo; a controlled-English style standard as a
hard rule (a light version came back as guidance with a soft check:
[record 0005](records/0005-plain-english.md)). A practice earns a place by paying for itself in more than one project.


## Status

Version 0.1. The decisions behind it are in [`docs/records/`](records/). Work is
tracked in issues; the rules for working on yokoten are in [`AGENTS.md`](../AGENTS.md).
