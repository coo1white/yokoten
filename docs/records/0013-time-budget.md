# 0013 The hooks have a time budget

Status: accepted; changes the copies part of [0008](0008-npm-package.md)
Date: 2026-10-20 (UTC)

## Context

The guard runs before every tool call of every agent. Doctor runs at every session
start, and the commit check at every commit. Users feel each millisecond, and the owner
says speed matters as much as features (#408).

On a WSL 2 laptop, a guard call took about 88 ms and a session start about 145 ms. A bare
`node -e ''` took 16 ms. Most of the rest was loading and type-stripping about 45 `.ts`
modules, not the checks:

- Every command loaded every module, doctor and init too.
- A `.ts` entry loads Node's type stripper first: about 25 ms, before any yokoten code runs.
- The guard reads each call in a worker thread, so it can stop a read that runs too long
  (#274). The worker starts a second Node environment and loads the rules again: about
  30 ms.
- A session start runs git 16 times, 6 of them to read the same thing again.

## Decision

- **A budget, checked in CI.** `scripts/bench.ts` makes a new repo with `init` and runs
  each hook entry from its `.yokoten/` copy, as the hooks do: the guard on a Bash call and
  on an Edit call, the session start, and the commit check. It runs at low priority and
  takes the median (p50) and p95 of 10 runs. It fails over this budget, on a CI Linux
  runner:

  | Entry | p50 | p95 |
  |---|---|---|
  | Guard (Bash, Edit) | 100 ms | 200 ms |
  | Session start | 130 ms | 260 ms |
  | Commit check | 100 ms | 200 ms |

  On the laptop above they now take about 75, 90 and 60 ms. The budget leaves room for a
  slower runner. Lower it when CI shows it can hold less, and when a change below lands.
- **A copy runs a prebuilt bundle.** `npm run build` (and so `npm pack`) bundles
  `bin/` and `src/` with esbuild into `bin/bundle/`: `main.mjs` for the command, and
  `guard.mjs` for the guard's worker. `bin/bundle/` is git-ignored. `install` and `init`
  copy it only when its `sources.sha256` matches the `.ts` files they copy. A copy (it has
  a `VERSION` file) runs the bundle when it has one; the repo never does. So the bundle is
  always the code next to it, and a stale build can't run.
- **The hook path stays `bin/yokoten.ts`.** No hook, workflow or doc changes.
- **Each command loads its own modules only.** A guard call never loads doctor or init.
- **The guard starts its worker first.** The worker starts while the rest of the hook
  loads and reads the call.
- esbuild is a dev dependency. yokoten still has no runtime dependency.

## Options not taken

- **Commit the bundle.** It is build output, and it would go stale between builds. The
  hash check gives the same speed to every copy without that.
- **Run the guard without a worker.** It is about 30 ms faster, but a read that runs too
  long could no longer be stopped, and the runtimes let the call through on their own
  timeout (#274).
- **A `.mjs` entry for the hooks.** It saves the type stripper's 25 ms on every call. But
  every hook command, the plugin, the git hook, the workflows and the docs name
  `yokoten.ts`, and doctor finds yokoten's hooks by that name. That is its own change.

## Consequences

- A copy is about 640 kB bigger: the bundle holds the code a second time.
- The Claude Code plugin runs from a clone of the repo, which has no bundle. It gets the
  lazy imports and the early worker, not the bundle.
- A copy edited by hand runs its bundle, not the edits. Copies are yokoten's to replace
  whole, and `init` and `install` write them again.
- The `.mjs` entry and fewer git calls at session start are the next steps under the
  budget. Together they would make the guard and session start about twice as fast as
  before this record.
