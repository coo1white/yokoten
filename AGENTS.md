# How work is done here

This file is for every agent and every person working in this repo. It starts from
[yokoten](https://github.com/coo1white/yokoten)'s core rules; the project's own section is
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
| 5 | A worker does not change lead-only files: these rules, agent config, hooks, CI. | Risk: a pull request that edits CI runs that CI before anyone reads it. | Tool guard and commit check; the bot has no Workflows permission |
| 6 | Never skip the commit check (`--no-verify`, changing `core.hooksPath`). | Risk: a skipped check makes a broken commit look reviewed. | Tool guard; CI runs the same check |
| 7 | No plain force push. Merge `main` into a branch only on a real conflict; never rebase a shared branch. | Risk: a force push throws away commits someone else pushed. | Tool guard; branch ruleset |
| 8 | Squash merge. One pull request, one purpose; small polish goes in one batch. | Incident: the owner was asked to review a +3 −2 pull request on its own and said small changes should not each cost a review. | Repo settings (squash only) |
| 9 | Review and test the exact commit that merges. The reviewer only reads; the verifier runs it. | Incident: two pull requests, each green on its own, broke `main` together, twice. | `inspect` skill; merge queue where the host has one |
| 10 | No folder holds more than 7 entries (the root is not counted). | Risk: a flat folder grows until nobody can find anything. Set as a standard by the owner. | Commit check (layout) |
| 11 | Nothing in the repo points at a person: no personal email, IP, name, city or private domain. | Incident: the old check read only the live docs, and server names and addresses were still in 56 tracked files. | Commit check and CI (privacy); `check --history` before going public |
| 12 | Decisions are written down once and kept. A changed decision gets a new entry that points back. Facts are replaced, not added to. Times are UTC. | Risk: a decision that lives only in a chat gets argued again. | `record` skill |

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
`yokoten init`, and the hooks here run `bin/yokoten.mjs` directly.

- **Test**: `node --test` (Node 22 or later). **Check**: `node bin/yokoten.mjs check`.
- **No dependencies.** Node's standard library only. A hook that needs `npm install`
  first is a hook that does not run on a fresh machine.
- **Scripts are `.mjs`.** No Python, no shell beyond the one-line git hook.
- **`kit/` is what other projects get.** A change there changes every project on its
  next `init` or `install`. Say so in the pull request.
- **Every new check gets a positive control**: a test (and, for doctor, a self-test
  case) that feeds it a known-bad input and expects a catch.
- **Examples use placeholders**: `example.com` addresses and `192.0.2.0/24` IPs. A
  test that needs a real-looking sample builds it from pieces (see
  `test/privacy.test.mjs`), so the repo passes its own privacy check.

### Commits and versions

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. A pull request's
  squash title is its one commit on `main`, so the title follows the same form.
  The body says why; `Closes #N` links the issue.
- **Versions** follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor
  bump may break things; say so in the changelog.
- **`CHANGELOG.md`**: every pull request that changes behaviour adds a line under
  `[Unreleased]`. At release, the owner moves those lines under the new version,
  bumps `package.json`, and creates the `vX.Y.Z` tag. Agents never tag (core rule 3).
