# 0004 doctor is a guide: the road in five stages

Status: accepted
Date: 2026-10-18 (UTC)

## Context

yokoten exists so that someone new to programming starts on the right road, the one
software teams use, and can walk it with AI agents without getting hurt. Two things
stop a beginner: breaking something, and not understanding what they are told. The
guards answer the first. Today `doctor` makes the second worse: a session in a new
project opens with "this project is missing 5 practice(s)" and a list. For someone who
has never heard of a commit check, that is a wall.

Anthropic's [AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)
describes the same road for teams: agents do the work in a loop, people hold the gates,
hooks are the deterministic guardrails, a fix may not edit tests, a reviewer agent can't
approve, every incident becomes a check. yokoten is that road for one person who has
never walked it.

Before deciding, we compared the road with the common standards: OpenSSF Scorecard, the
OpenSSF Best Practices badge, OSPS Baseline, SLSA, DORA, the Microsoft engineering
playbook, Google's review guide, ITIL change types, AGENTS.md, Conventional Commits,
SemVer and Keep a Changelog. No one standard covers what yokoten does. Most of its
checks match an item in one of them. What none of them has: rules that act while the
agent works, one next step worked out from the repo, and a risk tier based on how hard a
mistake is to undo.

## Decision

`doctor` becomes a guide. The road has five stages. Each holds a few steps, and each step
is a check yokoten can run.

| Stage | Steps (the check behind each) | Where the check runs |
|---|---|---|
| **1 · Safety net** | rules (`AGENTS.md`), tool-hook, commit-check (privacy and secrets), runtime, tests (a test command exists) | local |
| **2 · Issues and pull requests** | ci (CI runs `yokoten check` and the tests), issues (no todo file), templates (issue and PR templates), labels (the standard set), milestone (at least one), board (optional), no-build-output (no `dist/` or binaries committed) | local and GitHub (#10) |
| **3 · Release** | changelog (`CHANGELOG.md` with Unreleased), titles (CI checks PR titles), first-release (a `v*` tag, made by the owner) | local (#34) |
| **4 · A team of agents** | codeowners, bot (an App configured on this machine), skills, review (the owner approves the bot's pull requests) | local and GitHub |
| **5 · Going public** | history (privacy check over every commit), security-files (`SECURITY.md`, Dependabot, `LICENSE`), protection (rulesets on `main` and `v*`), security-settings | local and GitHub (#7, #35) |

**Plan joins stage 2.** Labels and a milestone are what the pull request check (#47)
needs, so they sit next to it. The board is optional: it shows progress, and nothing
else depends on it.

**The stage is worked out, never saved.** A project is at the first stage with a step
that is neither done nor marked "not now". Nothing in `yokoten.json` says "stage 3", so
nothing can drift from the truth.

**The order is advice, not a gate.** A step from a later stage can be done any time and
counts as done. Nobody is blocked from releasing because they have no board.

**A session hears three lines, about one step:**

```
yokoten: stage 2 of 5, issues and pull requests. Next: CI does not run `yokoten check`.
Why: a commit made with the hook off would reach main unchecked.
Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).
```

The agent explains the step in the user's language. yokoten prints English, which agents
read most reliably. Full `doctor` shows the whole map: every stage, every step done,
next, not now, or can't check.

**Each step names the outside standard it meets**, when there is one, for example
`Scorecard: Token-Permissions · OSPS-BR-07.01`. Progress in yokoten then means something
outside yokoten.

**Stage 5 is done when the repo meets [OSPS Baseline](https://baseline.openssf.org/)
level 1.** We also want these Scorecard checks at 10: Security-Policy, License,
Dangerous-Workflow, Token-Permissions, Binary-Artifacts, Dependency-Update-Tool,
Pinned-Dependencies, SAST, Vulnerabilities. We don't aim at the Scorecard total. A solo
project can't pass Contributors or Maintained (a repo under 90 days old), and Code-Review
needs a second identity. A solo project can do everything right and still score under 7.

**Stage 4 makes review possible for one person.** Scorecard counts a change as reviewed
when the person who merges it is not the person who wrote it. When the bot opens pull
requests and the owner approves and merges them, "require one approval" becomes a rule a
solo owner can live with. We read this from the Scorecard docs and have not tested it
yet. Rulesets are free only on public repos, so on a private repo without GitHub Pro the
review rule waits for stage 5.

**Tiers match ITIL change types.** Tier C is a standard change: pre-approved, merged when
CI passes. Tier B is a normal change: reviewed, then merged. Tier A needs the owner. The
tier measures how hard a mistake is to undo. Urgency is a different thing: a hotfix gets
the `hotfix` label, not a fourth tier.

**A large pull request gets a note.** `check --pr` notes a diff over about 400 changed
lines. The note never fails CI. Google's guide: about 100 lines is fine; about 1000 is
too large.

**GitHub checks don't slow a session.** Steps that need the GitHub API run in full
`doctor`, which saves what it found in `.git/yokoten/state.json` (per clone, never
committed). A session reads that file and never calls the network. When `gh` isn't
signed in, those steps show as "can't check", not as done.

**Step names stay the keys for "not now".** The existing names (`rules`, `commit-check`,
`tool-hook`, `ci`, `runtime`, `issues`) keep working in `yokoten.json`.

**GitHub first, other hosts later, through one boundary.** A step names what it needs
in host-neutral words ("the standard labels exist", "main is protected"), never a
GitHub endpoint. The `github` layer becomes `host`: a neutral interface (labels,
milestones, board, branch and tag protection, security settings, a bot token) and one
adapter per host, `src/host/github.ts` first, the way `src/agents/` holds one file per
agent. The host is worked out from the `origin` remote (github.com), or named in
`yokoten.json` for a self-hosted one. A host with no adapter shows its steps as "can't
check", never as done. Gitea already reads `.github/workflows` and `.github/ISSUE_TEMPLATE`,
so most of the kit carries over. Its adapter is later work, after the hackathon. The
architecture test holds the boundary: nothing outside `src/host/` names a host's API.

**Built in pieces.** #33 builds the road and the local steps. #10, #34, #35 and #7 each add
their steps' checks. Until a check exists, its step isn't shown.

## How the road maps to the playbook

| Playbook stage | yokoten |
|---|---|
| Plan (intent) | stage 2: the issue is the intent; milestones and the board |
| Design (spec) | not yet: a `spec.md` per larger issue is a candidate for later |
| Build (hooks, skills, parallel sessions) | stage 1 guards; stage 4 workers in worktrees, the dispatch skill |
| Test (feedback loop, no test edits in a fix) | stage 1 tests and test guard; stage 2 CI |
| Deploy (AI review can't approve, a gate before release) | stage 3: only the owner tags; stage 4: reviewer reads only, the owner approves |
| Maintain (incidents become checks) | the `rca` skill and `incident` issues; stage 5 Dependabot and security settings |

Two gaps, left for later: spec and plan files, and running the self-test in CI whenever
the rules, skills or hooks change.

## Options not taken

- **Six stages, with Plan on its own.** Plan has the least support in the standards, and
  its labels and milestone already belong to the pull request check. Fewer stages also
  scare a beginner less.
- **Keep the list of everything missing.** It is correct and it scares people off. The
  full map is still one command away.
- **Save the stage in `yokoten.json`.** A saved stage goes stale the day someone deletes
  a file. Working it out each time costs a few file reads.
- **Lock later stages until earlier ones are done.** Real projects don't arrive in order,
  and an old project adopting yokoten may already release properly with no board.
- **A Scorecard total as the goal.** See stage 5 above: a solo project can't reach it.
- **Points, badges, levels with names.** Noise. The reward is a project that works the
  way good teams work. The Best Practices "passing" badge stays an option after stage 5.
- **Write the host checks straight against GitHub, and abstract later.** Cheaper today,
  but every step would then name GitHub endpoints, and adding Gitea would mean touching
  each one. The boundary costs one interface now.
- **Call the GitHub API in every session.** Slow, fails offline, and a session start must
  never hang.

## Consequences

- A beginner hears one thing at a time, with the reason, and the agent offers to do it.
- The README's road and `doctor` say the same thing in the same order.
- Each new practice must find its place on the road. A practice that fits no stage
  probably doesn't belong in the kit.
- New checks: tests, no-build-output, review, the large pull request note, and the
  outside standard names.
- Tests: each stage boundary (a repo with stage N done reports stage N+1), the "not now"
  skip, the "can't check" case, and a fresh empty repo that reaches stage 5 by following
  only what `doctor` says.

## Update (2026-10-18)

Stage 3 checks `changelog` and `titles` only. `first-release` is left out: many new
projects do not release for a long time, and the stage would hold them there and hide
stages 4 and 5. When to ship is the owner's call, not the tool's. A first tag may come back
later as a note, never as a gate (#34, #79).
