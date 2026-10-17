# 0004 doctor is a guide: the road in six stages

Status: proposed
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

## Decision

`doctor` becomes a guide. The road has six stages; each holds a few steps, and each step
is a check yokoten can run.

| Stage | Steps (the check behind each) | Where the check runs |
|---|---|---|
| **1 · Safety net** | rules (`AGENTS.md`), tool-hook, commit-check, runtime | local |
| **2 · Issues and pull requests** | ci (CI runs `yokoten check`), issues (no todo file), templates (issue and PR templates) | local |
| **3 · Plan** | labels (the standard set), milestone (at least one), board (a project linked to the repo) | GitHub (#10) |
| **4 · Release** | changelog (`CHANGELOG.md` with Unreleased), titles (CI checks PR titles), first-release (a `v*` tag, made by the owner) | local (#34) |
| **5 · A team of agents** | codeowners, bot (an App configured on this machine), skills | local |
| **6 · Going public** | history (privacy check over every commit), security-files (`SECURITY.md`, Dependabot), protection (rulesets on `main` and `v*`), security-settings | local and GitHub (#7, #35) |

**The stage is worked out, never saved.** A project is at the first stage with a step
that is neither done nor marked "not now". Nothing in `yokoten.json` says "stage 3", so
nothing can drift from the truth.

**The order is advice, not a gate.** A step from a later stage can be done any time and
counts as done. Nobody is blocked from releasing because they have no board.

**A session hears three lines, about one step:**

```
yokoten: stage 2 of 6, issues and pull requests. Next: CI does not run `yokoten check`.
Why: a commit made with the hook off would reach main unchecked.
Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).
```

The agent explains the step in the user's language; yokoten prints English, which agents
read most reliably. Full `doctor` shows the whole map: every stage, every step done,
next, not now, or can't check.

**GitHub checks don't slow a session.** Steps that need the GitHub API (stages 3 and 6)
run in full `doctor`, which saves what it found in `.git/yokoten/state.json` (per clone,
never committed). A session reads that file and never calls the network. When `gh` isn't
signed in, those steps show as "can't check", not as done.

**Step names stay the keys for "not now".** The existing names (`rules`, `commit-check`,
`tool-hook`, `ci`, `runtime`, `issues`) keep working in `yokoten.json`.

**Built in pieces.** #33 builds the road and the local steps. #10, #34, #35 and #7 each add
their steps' checks; until a check exists, its step isn't shown.

## How the road maps to the playbook

| Playbook stage | yokoten |
|---|---|
| Plan (intent) | stage 2: the issue is the intent; stage 3: milestones and the board |
| Design (spec) | not yet: a `spec.md` per larger issue is a candidate for later |
| Build (hooks, skills, parallel sessions) | stage 1 guards; stage 5 workers in worktrees, the dispatch skill |
| Test (feedback loop, no test edits in a fix) | stage 1 test guard; stage 2 CI |
| Deploy (AI review can't approve, a gate before release) | stage 4: only the owner tags; stage 5: reviewer reads only, the owner approves |
| Maintain (incidents become checks) | the `rca` skill and `incident` issues; stage 6 Dependabot and security settings |

Two gaps, left for later: spec and plan files, and running the self-test in CI whenever
the rules, skills or hooks change.

## Options not taken

- **Keep the list of everything missing.** It is correct and it scares people off. The
  full map is still one command away.
- **Save the stage in `yokoten.json`.** A saved stage goes stale the day someone deletes
  a file. Working it out each time costs a few file reads.
- **Lock later stages until earlier ones are done.** Real projects don't arrive in order,
  and an old project adopting yokoten may already release properly with no board.
- **Points, badges, levels with names.** Noise. The reward is a project that works the
  way good teams work.
- **Call the GitHub API in every session.** Slow, fails offline, and a session start must
  never hang.

## Consequences

- A beginner hears one thing at a time, with the reason, and the agent offers to do it.
- The README's road and `doctor` say the same thing in the same order.
- Each new practice must find its place on the road; a practice that fits no stage
  probably doesn't belong in the kit.
- Tests: each stage boundary (a repo with stage N done reports stage N+1), the "not now"
  skip, the "can't check" case, and a fresh empty repo that reaches stage 6 by following
  only what `doctor` says.
