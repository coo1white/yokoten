# 0039 Policy rules: CEL, Rego or Cedar

Status: proposed; the owner accepts or refuses
Date: 2026-10-24 (UTC)

## Context

The guard's rules live in code and in `yokoten.json`. The owner agreed on 2026-10-24
not to invent a language for them, and to stand on an existing one if the rules outgrow
the config. This record compares three: CEL (Common Expression Language, Google, open
source), Rego (Open Policy Agent) and Cedar (AWS).

CEL comes first because it is small, has no loops and no side effects, always ends, and
already carries policy in Kubernetes and Firebase.

Nothing here changes a rule. The framework is locked until after the hackathon and
#898 (records 0028–0031), so this record only answers what a later change would cost.

## What the guard's rules look like today

The guard is mostly a parser, not a rule list. `src/rules/guards.ts` is about 6,500
lines: it reads a command line, works out what the command would touch, and then asks a
small predicate. A policy language can replace the predicate. It cannot replace the
parser, because the parser needs facts a CEL expression does not have: which program
runs, which arguments matter, which path a glob reaches.

The config holds about nine settings: `layout.maxEntries` and `layout.exempt`,
`tests`, `leadOnly`, `privacy.allow` and `privacy.skip`, `commands.block`,
`allowBuild`, `areas`, and `worker.timeLimitMinutes`. Each one is a list or a number.
That is the part a policy language would hold.

## Three rules, both ways

### 1. A blocked program (`commands.block`)

Today, in code (`src/rules/guards.ts`, `checkBlocked`):

```ts
const name = programs.map(programName).find((program) => Object.hasOwn(blockList, program));
if (name === undefined) return null;
```

In CEL, after the parser hands over the program names:

```
programs.exists(p, p in config.commands.block)
```

This is a clear win: one line says what the two code lines say, and the owner can read
it in the config.

### 2. A force push

Today, in code (`src/rules/guards.ts`):

```ts
const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
if (force) return finding('force-push', `git push ${force} forces the push`, ...);
```

In CEL:

```
sub == "push" && args.exists(a,
  a == "--force" || a.matches("^-[a-zA-Z]*f[a-zA-Z]*$") || a.startsWith("+"))
```

This is a small win. The rule becomes one readable condition, but the short-option
regular expression stays, because no policy language knows that `-f` is force.

### 3. A commit time that is not UTC

Today, in code (`src/rules/privacy.ts`, `notUtc`):

```ts
const zone = /\s([+-]\d{4})\s*$/.exec(ident)?.[1];
return zone !== undefined && zone !== '+0000' && zone !== '-0000';
```

In CEL, with the zone already extracted by the caller:

```
zone != null && zone != "+0000" && zone != "-0000"
```

CEL can also test the whole identity, but its `matches` returns true or false and has no
capture groups:

```
ident.matches(".*\\s[+-][0-9]{4}\\s*$") && !ident.matches(".*\\s[+-]0000\\s*$")
```

This is no win. CEL is shorter only when the parser already extracts the zone. CEL does
not remove the need to read the command or the git output.

The same holds for `leadOnly` and `tests`: the globs (`*`, `**`) are yokoten's, not
CEL's. CEL `matches` takes a regular expression and returns a boolean. A rule file would
hold regular expressions, or need one registered helper for globs. `layout.maxEntries`
fits CEL well; its `exempt` globs have the same problem.

## Dependencies (npm, checked 2026-10-24)

| Package | Licence | Dependencies | Unpacked size |
|---|---|---|---|
| `@marcbachmann/cel-js` 8.0.0 | MIT | none | 227 KB |
| `cel-js` 0.8.2 | MIT | `chevrotain`, `ramda` (about 1.2 MB each) | 69 KB |
| `@bufbuild/cel` 0.6.1 | Apache-2.0 | `@bufbuild/re2`, `@bufbuild/cel-spec` | 901 KB |
| `@open-policy-agent/opa-wasm` 1.10.0 (Rego) | Apache-2.0 | `sprintf-js`, `yaml`; policies compiled by the OPA tool | 973 KB |
| `@cedar-policy/cedar-wasm` 4.14.0 (Cedar) | Apache-2.0 | none | 13.5 MB |

All five licences are permissive. Only one is small and has no dependencies:
`@marcbachmann/cel-js`. The project rule is "no runtime dependencies", so even that one
needs an explicit decision. Vendoring it would break that rule in a worse way: the copy
would age without `npm`'s licence and security notes.

Rego is a general policy language with iteration and comprehensions. It is more than
these rules need, and its Node path is a WASM module that runs a policy bundle built by
the OPA command-line tool. Cedar is an authorization language: a principal asks to do
an action on a resource, and a policy set answers. It would model every guard check as
an authorization request for a 13.5 MB WASM module. Neither shape fits a command line.

## Speed

The baseline is 88 ms per guard call and a 100 ms target (#408, record 0013). Measured
on this Mac (arm64, Node 26.12.1), with `@marcbachmann/cel-js` 8.0.0:

- Parse one small expression: 2–4 µs. A rule file of ten rules costs about 40 µs at
  start, once.
- Evaluate one expression: 0.15–0.31 µs, over 100,000 calls.
- Cold import in a fresh process: about 10 ms (0.11 s to 0.12 s).

So a call that imports CEL and evaluates one rule costs about 98 ms of the 100 ms
budget. The evaluation is free; the import is the cost. A lazy import, only when the
repo has a CEL rule file, keeps every repo without one at the baseline. Parse once per
process, then evaluate per action.

The benchmark lives in `.tmp/celbench/bench.mjs` (not committed). It compares each
expression with the same predicate written in plain JavaScript; CEL was 8 to 30 times
slower per call, and both are far below 1 µs.

## Parsing risk

- CEL is a second grammar in the guard. Today the guard accepts a small character set
  and refuses a command it cannot read. A bug in a policy parser could read a rule the
  wrong way. A wrong rule can let an action through.
- The rule file is written by the owner and is lead-only, never by an agent. The input
  is not untrusted, so the risk is a mistake in one file, not an attack.
- CEL has no loops, no recursion and no side effects, so an expression always ends. The
  parser cost grows with the file; parse at load, not per command.
- Mitigations, if adopted: parse and type-check every rule at load; any error stops the
  guard, never skips the rule; keep the security floor (force push, `.git`, secrets,
  home folder) in code; add a positive control for each rule file.

## Options not taken

- Write our own expression language. The owner ruled it out: more code to keep, and no
  outside reader.
- Move the whole guard into Rego. The parser would stay in TypeScript and call a WASM
  policy for every step. More moving parts, slower, and a toolchain to install.
- Model the rules in Cedar. Correct for "who may do what", wrong for "is this folder
  over seven entries". The request shape adds a schema per rule.

## Recommendation

Do not adopt CEL now. The rules fit `yokoten.json`, and the guard's size is the parser,
which no policy language replaces. Adopting one now buys nothing and costs a dependency.

When the rules outgrow the config, adopt `@marcbachmann/cel-js`: MIT, no dependencies,
227 KB, and the fastest of the three. Add a `rules` key that names a CEL file, import the
package only when that key exists, parse once at start, and fail closed. Keep the
security floor in code.

The signal to revisit is a project that needs a rule the config cannot say: a condition
across two fields, or the same custom rule in three projects. Then this record is the
starting point, and the owner decides.

## Consequences

- No code, no dependency and no test changes now.
- The guard stays at its 88 ms baseline for every repo.
- #898 and the hackathon come first, as records 0028–0031 say.
