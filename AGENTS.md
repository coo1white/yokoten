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

- **The owner** decides what is built and when it ships. Only the owner approves pull
  requests, creates release tags, and changes repo settings.
- **The lead** is the session the owner talks to. It plans, splits the work, reviews,
  commits and opens pull requests (as the bot, never as the owner).
- **A worker** is a session the lead starts for one task, in its own worktree, with
  `YOKOTEN_ROLE=worker`. It changes code and tests, and reports back. It never pushes.

## Core rules

| # | Rule | Why | Check |
|---|------|-----|-------|
| 1 | Every piece of work starts as an issue. No todo files. | Incident: follow-ups written only in chat reports were nearly lost; a shared todo file made one PR run CI four times on merge conflicts. | `doctor` reports todo files |
| 2 | Nothing reaches `main` without a pull request and green CI. | Risk: one bad push breaks every branch built on it. | Branch ruleset on the server |
| 3 | Only the owner creates tags and releases. | Risk: when to ship is the owner's call, and a pushed tag can start a release. | Tool guard; tag ruleset on the server |
| 4 | A fix task changes code, never tests (`YOKOTEN_FIX_TASK=1`). | Risk: the fastest way to make a test pass is to change what it asserts. | Tool guard and commit check |
| 5 | A worker does not change lead-only files: these rules, agent config, hooks, CI. | Risk: a pull request that edits CI runs that CI before anyone reads it. | Tool guard and commit check for workers; for the bot, no Workflows permission, or CODEOWNERS review of CI changes with every secret behind a protected environment |
| 6 | Never skip the commit check (`--no-verify`, changing `core.hooksPath`). | Risk: a skipped check makes a broken commit look reviewed. | Tool guard; CI runs the same check |
| 7 | No plain force push. Merge `main` into a branch only on a real conflict; never rebase a shared branch. | Risk: a force push throws away commits someone else pushed. | Tool guard; branch ruleset |
| 8 | Squash merge. One pull request, one purpose; small polish goes in one batch. A pull request has a commit-form title, a `tier:` line, Why / What changed / How tested, a linked issue, a file in `changes/` when behaviour changes, a milestone and labels. An issue title is `area: verb phrase` (a task) or `area: symptom` (an incident): at most 60 characters, no full stop, no `#N`. | Incident: the owner was asked to review a +3 −2 pull request on its own and said small changes should not each cost a review. | Repo settings (squash only); `check --pr` and `check --issue` in CI |
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

yokoten is its own first user: this file came from `kit/project/AGENTS.md` by
`yokoten init`, and the hooks here run `bin/yokoten.ts` directly.

- **Test**: `node --test` (Node 22.18 or later). **Types**: `npm run typecheck`.
  **Check**: `node bin/yokoten.ts check`.
- **No runtime dependencies.** Node's standard library only. A hook that needs
  `npm install` first is a hook that does not run on a fresh machine. TypeScript and
  `@types/node` are dev dependencies, for `tsc` alone.
- **TypeScript that Node runs as it is.** No build in the repo: Node strips the types.
  Only the npm package is built: `npm pack` emits `dist/` (git-ignored), because Node
  does not strip types under `node_modules` (record 0008). So only syntax it can erase
  (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties. Imports
  name the `.ts` file. Code is `.ts` only: no `.js`, `.mjs`, `.cjs` or `.tsx`
  (`test/architecture.test.ts` holds this). No Python, no shell beyond the one-line git
  hook.
- **Layers.** `src/` has five, lowest first; a module imports only from its own
  layer or a lower one (`test/architecture.test.ts` holds this):
  - `rules/`: what is allowed, as plain functions (guards, privacy, layout, config).
  - `run/`: the checks at work: the tool-call hook, the commit and CI check.
  - `agents/`: one adapter per AI runtime: its tool-call shape, its settings and
    hooks, and for `claude-code.ts` where its skills and agents go. `codex.ts` and
    `gemini.ts` have the tool call and the project hook. Shared by several runtimes:
    `agent-skills.ts`, the `.agents/skills` folder, and `hooks-file.ts`, the hooks
    table. Nothing else in `src/` names a runtime.
  - `host/`: one adapter per code host. `github.ts` is the first: the bot's token
    and the pull request of a CI run. Nothing else in `src/` or `bin/` names a host's
    API (`test/architecture.test.ts` holds this).
  - `setup/`: `install`, `init` and `doctor`, writing yokoten into a machine or a
    project. `road.ts` is the road `doctor` walks: one table of stages and steps.
- **Names** (record 0006): the core "Names" rules, in TypeScript. Short forms: `id`,
  `url`, `pr`, `ci`, `env`, `config`, `repo`, `dir`, `json`, `html`. `camelCase` for
  values and functions, `PascalCase` for types, `CONSTANT_CASE` only for fixed values at
  the top of a file. Acronyms as words (`loadHttpUrl`). `_` only for a parameter we don't
  use. One letter only when used within 10 lines and not exported.
  `test/architecture.test.ts` holds the 4-word and one-letter rules and `CONSTANT_CASE`;
  the reviewer holds the rest.
- **Docs live in the repo.** No wiki: a wiki page is not reviewed and agents do not read
  it. Decisions go in `docs/records/`; what went wrong and what check now holds it goes
  in an issue labelled `incident`, and the rule's "why" in `AGENTS.md` points to it.
- **`kit/` is what other projects get.** `install` replaces the skills and agents it
  manages on each machine. `init` adds only missing files, so it never changes a
  project's `AGENTS.md` again. The core rules in it change when the project runs
  `yokoten update --write`; `doctor` says when they are behind. Say so in the pull request.
- **Every new check gets a positive control**: a test (and, for doctor, a self-test
  case) that feeds it a known-bad input and expects a catch.
- **Examples use placeholders**: `example.com` addresses and `192.0.2.0/24` IPs. A
  test that needs a real-looking sample builds it from pieces (see
  `test/privacy.test.ts`), so the repo passes its own privacy check.

### Commits and versions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. A pull request's
  squash title is its one commit on `main`, so the title follows the same form.
  The body says why; `Closes #N` links the issue.
- **Versions** follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor
  bump may break things; say so in the changelog.
- **`CHANGELOG.md`**: every pull request that changes behaviour adds a file in
  `changes/` (`changes/README.md` shows the form), not a line in `CHANGELOG.md`, so pull
  requests never conflict. At release, an agent may prepare a `chore: release vX.Y.Z`
  pull request (the `release` skill): it runs `node bin/yokoten.ts changelog --write`,
  proposes the version, and after the owner agrees it moves the `[Unreleased]` lines
  under the new version and bumps `package.json`. The owner reviews and
  merges it, then creates the `vX.Y.Z` tag. Agents never tag (core rule 3).
