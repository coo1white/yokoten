# 0016 Commands run in the test process, and CI keeps the tests fast

Status: accepted
Date: 2026-10-21 (UTC)

## Context

On one CI run (Node 24), the 691 tests took 365 s added up. About 280 s of that was tests
that start `node bin/yokoten.ts` as a child process. Each child strips the TypeScript of every
file it loads again, and on Node 22 that is 3 to 6 times slower (#472). Most children ran
after a fresh `git init` and a commit. The 243 tests that called a function in-process took
under 1 s together.

A test could not run a command in-process. `src/commands/shared.ts` read the command line
and the environment from the process when it loaded, and `print` wrote to the process's
output. One process could hold one command line only. Splitting CI into shards (#473) only
spread the cost; it grew with every test (#475).

## Decision

- **A command gets an `Invocation`.** It is plain data: command, args, env, cwd, stdin,
  stdout and stderr. `runFromProcess` in `bin/main.ts` is the one place that reads the real
  process. An architecture test fails on any read of `process.argv`, `env`, `cwd`, `stdin`,
  `stdout` or `stderr` below it, and on `process` used as a value. It stays a record, not a
  class that grows methods: the owner asked for no god classes.
- **Tests call commands in-process.** The sandbox's `call` (and `invoke` in
  `test/repo/invoke.ts`) runs a command in the test process, with the same `{ status, stdout,
  stderr }` result as the child `run`. Each command keeps one or two child tests for its
  entry. A child also stays where the process itself is under test: a node option, a shell
  that runs a hook, another copy of yokoten, exit by signal. Each such child has a comment
  saying why.
- **A test repo is copied, not built.** Tests copy a template repo made once per test process
  (`test/repo/git-template.ts`), instead of running `git init` and a commit each time.
- **Timing controls use a simulated clock.** `assertLinear` and `assertLinearEach` take an
  optional clock. Their controls pass a simulated one, so a busy runner can't change the
  result (#493). The real linear-time checks keep the wall clock.
- **Two checks keep it fast:**
  - An architecture test counts, in each test file, the places that start a node child. It
    fails over 4. Six files have an allowance at today's count, each with a reason, and an
    allowance can only go down.
  - `scripts/time/suite.ts` reads each shard's TAP report. It writes the time and the 5
    slowest tests to the job summary, and fails over 180 s, or over 90 s on Node 24 on Linux.
    The cap is the stable check. The time is the backstop, set far above normal so a slow
    runner does not fail it.

The CI test time, three shards added up:

| Setup | Before | After |
|---|---|---|
| Node 24, Linux | 141 s | 85 s |
| Node 22, Linux | 278 s | 124 s |
| Node 24, macOS | 317 s | 191 s |

## Options not taken

- **More shards.** They cut the wait, not the cost, and the cost grows with the suite.
- **A service object passed to every command.** It would hold the process and grow a method
  for each new need: the god class the owner ruled out.
- **A budget for each test file.** Node's TAP report does not say which file a test is in.
- **A tight time budget alone.** CI runners vary by 2x or more between runs, so a tight
  budget is flaky, and a loose one only catches a large jump. The count of children does not
  depend on the runner.
- **A compile-cache hook for Node 22** (branch `ci-node22-hook`). With few children left,
  Node 22 is no longer the slowest job by far.

## Consequences

- A new test of a command uses `sandbox.call`. A child needs a reason in a comment, and the
  cap test fails when a file has more than 4.
- A new command reads its input from the `Invocation` only; the architecture test holds it.
- The cap counts places in the code, not runs: a child in a loop counts once. It does not see
  a child started through a shell.
- `scripts/bench.ts` moved to `scripts/time/bench.ts`, next to `suite.ts`.
