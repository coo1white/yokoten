# 0013 The hooks have a time budget

Status: accepted
Date: 2026-10-20 (UTC)

## Context

The guard runs before every tool call of every agent. Doctor runs at every session
start, and the commit check at every commit. Users feel each millisecond, and the owner
says speed matters as much as features (#408).

On a WSL 2 laptop, a guard call took about 88 ms and a session start about 145 ms. A bare
`node -e ''` took 16 ms. Most of the rest was loading yokoten, not the checks:

- A `.ts` entry makes Node load its type stripper before any yokoten code runs: about
  25 ms. The compile cache (#286) can't help, because the entry is read before it is on.
- Every command loaded all of its ~45 modules, doctor and init too.
- The guard reads each call in a worker thread, so it can stop a read that runs too long
  (#274). The worker starts a second Node environment: about 30 ms, which the hook waited
  for at the end.
- A session start asked git the same question three times more than it needed.

## Decision

- **The agent hooks run `bin/yokoten.mjs`.** It is plain JavaScript, so Node starts it
  without the type stripper. It turns on the compile cache, then loads the `.ts` command.
  On a warm run every module comes from the cache, and the stripper never loads.
  `init` and `install` write the new path, and the plugin uses it too. `bin/yokoten.ts`
  still works and loads the same file. The git hook, CI and the docs keep it. Doctor and
  setup find a hook by either name, so `init` updates an old hook in place.
- **The cache lives in the user's cache folder:** `~/.cache/yokoten` (or
  `$XDG_CACHE_HOME`), `~/Library/Caches/yokoten` on macOS, `%LOCALAPPDATA%\yokoten\cache`
  on Windows. A restart may empty the temp folder, and then every hook starts cold.
  `NODE_COMPILE_CACHE` still names another folder.
- **Each command loads its own modules only.** A guard call never loads doctor or init.
- **The guard starts its worker first,** before the command loads. The worker then starts
  while the hook loads and reads the call.
- **Doctor asks git each question once per run.**
- **A budget, checked in CI.** `scripts/time/bench.ts` makes a new repo with `init` and runs
  each hook entry from its `.yokoten/` copy, as the hooks do: the guard on a Bash call and
  on an Edit call, the session start, and the commit check. It runs at low priority and
  takes the median (p50) and p95 of 10 runs. It fails over this budget, on a CI Linux
  runner:

  | Entry | p50 | p95 |
  |---|---|---|
  | Guard (Bash, Edit) | 100 ms | 200 ms |
  | Session start | 130 ms | 260 ms |
  | Commit check | 150 ms | 300 ms |

  On the laptop above, a guard call now takes about 0.63 times as long as before, and a
  session start about 0.7 times. The commit check still runs `yokoten.ts`, so it gains
  less, and its budget is wider. The budget leaves room for a slower runner. Lower it
  when CI shows it can hold less.

## Options not taken

- **A prebuilt bundle in each copy.** Bundling `bin/` and `src/` with esbuild was about
  10% faster again. But it put a 640 kB generated file in every project's committed
  `.yokoten/`, so each update would be a diff no one can read. The plugin runs from a
  clone and could not use it. And it needed a dev dependency and a check that the bundle
  is current.
- **Run the guard without a worker.** It is about 30 ms faster, but a read that runs too
  long could no longer be stopped, and the runtimes let the call through on their own
  timeout (#274).
- **Switch every path to `yokoten.mjs`.** The commit check would gain too, but the git
  hook, the workflows and the docs show `yokoten.ts` to people. That is a larger change
  for less: a commit is rarer than a tool call.

## Consequences

- The first call after an update, or after the cache folder is emptied, loads the type
  stripper and fills the cache; the next ones are fast.
- A hook that an older yokoten wrote runs `yokoten.ts` until `yokoten init` runs again. It
  is correct, only slower.
- `uninstall` leaves the cache folder. It holds only Node's compiled code.
