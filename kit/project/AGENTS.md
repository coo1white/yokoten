<!-- yokoten kit {{version}} -->
# How work is done here

This file is for every agent and every person working in this repo. It starts from
[yokoten](https://github.com/yokoten-labs/yokoten)'s core rules; the project's own section is
at the end.

Every rule names why it exists and the check that holds it. A rule with no check is a
wish: the check is what makes it true on a busy day. The "why" is an **incident** when
one happened, and a **risk** when the rule came first. Incidents are never made up; a
risk becomes an incident only when it happens. When a rule here fails, use the `rca`
skill: find the cause, add or fix the check, then carry the fix to the other projects.

## Roles

- **The owner** decides what is built and when it ships. Only the owner approves tier A
  pull requests, creates release tags, and changes repo settings.
- **The lead** is the session the owner talks to. It plans, splits the work, reviews,
  commits and opens pull requests (as the bot, never as the owner).
- **A worker** is a session the lead starts for one task, in its own worktree, with
  `YOKOTEN_ROLE=worker`. It changes code and tests, and reports back. It never pushes.

## The safe exit

- Stop after the same step fails three times in a row. Report where you stopped.
  Stopping is good work, not failure.
- Commit after each test you touch passes. That commit is the anchor you resume from.
- A new session in a worktree reads `git log --oneline -5` and `git status` first.
  Then continue from the last commit.

## Core rules

| # | Rule | Why | Check |
|---|------|-----|-------|
| 1 | Every piece of work starts as an issue. No todo files. | Incident: follow-ups written only in chat reports were nearly lost; a shared todo file made one PR run CI four times on merge conflicts. | `doctor` reports todo files |
| 2 | Nothing reaches `main` without a pull request and green CI. | Risk: one bad push breaks every branch built on it. | Branch ruleset on the server |
| 3 | Only the owner creates tags and releases. A general "merge", "ship it" or "go ahead" does not approve a release. Only an owner request that names the version or says "release", "publish" or "tag" does. | Risk: when to ship is the owner's call, and a pushed tag can start a release. | Tool guard; tag ruleset on the server |
| 4 | A fix task changes code, never tests (`YOKOTEN_FIX_TASK=1`). | Risk: the fastest way to make a test pass is to change what it asserts. | Tool guard and commit check |
| 5 | A worker does not change lead-only files: these rules, agent config, hooks, CI. | Risk: a pull request that edits CI runs that CI before anyone reads it. | Tool guard and commit check for workers; for the bot, no Workflows permission, or CODEOWNERS review of CI changes with every secret behind a protected environment |
| 6 | Never skip the commit check (`--no-verify`, changing `core.hooksPath`). | Risk: a skipped check makes a broken commit look reviewed. | Tool guard; CI runs the same check |
| 7 | No plain force push. Merge `main` into a branch only on a real conflict; never rebase a shared branch. | Risk: a force push throws away commits someone else pushed. | Tool guard; branch ruleset |
| 8 | Squash merge. One pull request, one purpose; small polish goes in one batch. A pull request has a commit-form title, a `tier:` line, Why / What changed / How tested, a linked issue, a file in `changes/` when behaviour changes, a milestone, a type label, and a tier label that matches the `tier:` line. An issue title is `area: verb phrase` (a task) or `area: symptom` (an incident): at most 60 characters, no full stop, no `#N`. | Incident: the owner was asked to review a +3 −2 pull request on its own and said small changes should not each cost a review. | Repo settings (squash only); `check --pr` and `check --issue` in CI |
| 9 | Review and test the exact commit that merges. The reviewer only reads; the verifier runs it. | Incident: two pull requests, each green on its own, broke `main` together, twice. | `inspect` skill; merge queue where the host has one |
| 10 | No folder holds more than 7 entries (the root is not counted). | Risk: a flat folder grows until nobody can find anything. Set as a standard by the owner. | Commit check (layout) |
| 11 | Nothing in the repo, or in what yokoten prints, points at a person or opens their accounts: no personal email, IP, name, city or private domain, and no secret (token or private key). A hit is reported by place, never by content; the home folder shows as `~`. | Incident: the old check read only the live docs, and server names and addresses were still in 56 tracked files. | Commit check and CI (privacy and secrets); `check --history` before going public |
| 12 | Decisions are written down once and kept. A changed decision gets a new entry that points back. Facts are replaced, not added to. Times are UTC, commit times included. | Risk: a decision that lives only in a chat gets argued again. Incident: every commit recorded the owner's time zone (#40). | `record` skill; commit check (commit time) |

## Writing

Plain English, close to ASD-STE100 (Simplified Technical English), because the readers
include beginners, people reading a second language, and agents. An instruction has at
most 20 words; a description at most 25. One instruction per sentence. One word for one
thing. Active voice. A flow gets a diagram. `check --pr` notes long sentences in changed
Markdown; a note never fails CI.

## Names

A name is what a reader meets first and reads most. Pick names that a new reader, or an
agent, understands without scrolling back. The yokoten guide says why:
[Naming](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#naming).

- Whole words. A short form only when everyone knows it (`id`, `url`, `config`). Never
  delete letters inside a word.
- At most 4 words. There is no character limit, because a limit makes people abbreviate.
- One letter only for a name used within about 10 lines, such as a loop counter.
- A function's name starts with a verb. A true/false value starts with `is`, `has` or
  `can`.
- One idea keeps one name in every file.
- Use the language's own case style, for example `camelCase` in TypeScript and
  `snake_case` in Python.

| Hard to read | Easy to read | Why |
|---|---|---|
| `r`, still used 30 lines later | `result` | By line 30 the reader has forgotten what `r` holds. |
| `cfgMgr` | `configManager` | Letters cut from inside words make the reader guess. |
| `processTheUserInputDataNow` | `parseInput` | Six words, and three of them say nothing. |
| `valid` | `isValid` | `is` says the value is only true or false. |

## Where to look

| For | Read |
|-----|------|
| Why something is the way it is | `docs/records/` |
| Handing a task to a worker | the `dispatch` skill |
| Reviewing a pull request | the `inspect` skill |
| Something went wrong | the `rca` skill |
| What this repo is missing | `yokoten doctor` |

## This project

<!-- The project's own rules go here: how to build and test, what not to touch, and
     any core rule it runs lighter or not yet (with the reason, in yokoten.json "notNow"). -->
