# 0006 Names: whole words, at most four, and a test

Status: accepted
Date: 2026-10-18 (UTC)

## Context

yokoten teaches new coders to organize and manage a codebase (record 0004). Its own code
is an example they read. Names are what a reader meets first and reads most, so they
must be easy to read.

The code had no rule for names. Most names were good, but some were one letter used far
from where they were made. In `src/rules/guards.ts`, `i` and `c` were used for 100 lines.
A reader had to scroll back to learn what they held.

What other people say:

- The [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
  says: "Names must be descriptive and clear to a new reader." It bans short forms that
  people outside the project don't know. It says: "do not abbreviate by deleting letters
  within a word." One letter is fine for a variable used within 10 lines and not
  exported. It sets no maximum length. Acronyms are written as words (`loadHttpUrl`).
  `CONSTANT_CASE` is for module-level values only. It bans a `_` at the start or end of
  a name, and a lone `_`.
- The [TypeScript team's guide](https://github.com/microsoft/TypeScript/wiki/Coding-guidelines)
  says: "Use whole words in names when possible." It is written for people who work on
  TypeScript itself, not for every TypeScript project.
- The [Linux kernel coding style](https://www.kernel.org/doc/html/latest/process/coding-style.html)
  keeps local names short (`i`, `tmp`) and makes global names descriptive.
- The Go guide's "Variable Names" section
  ([Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)) says the same in
  one line: the further a name is used from where it is declared, the more it must say.
- ESLint's [`id-length`](https://eslint.org/docs/latest/rules/id-length) rule has a
  minimum of 2 characters by default, and no maximum.
- Hofmeister, Siegmund and Holt,
  ["Shorter Identifier Names Take Longer to Comprehend"](https://www.se.cs.uni-saarland.de/publications/docs/HoSeHo17.pdf)
  (SANER 2017). 72 developers looked for defects in code. With whole words they were
  about 19% faster than with letters or short forms.
- Schankin and others (ICPC 2018) followed it up. With descriptive names of several
  words, developers found defects in meaning about 14% faster.
- For balance: Greg Wilson
  [calls 19% "fairly small"](https://neverworkintheory.org/2021/08/09/abbreviated-vs-full-names.html).
  The gain is real, but it is not large. We take the rule mostly because it teaches,
  not because it makes code much faster to read.

## Decision

yokoten's code follows five rules. `AGENTS.md` lists them under "Names".

1. Whole English words. Only widely known short forms: `id`, `url`, `pr`, `ci`, `env`,
   `config`, `repo`, `dir`, `json`, `html`. Never delete letters inside a word.
2. At most 4 words per name. No character limit.
3. One letter only when used within 10 lines and not exported. `_` only for a parameter
   we don't use.
4. `camelCase` for values and functions, `PascalCase` for types. `CONSTANT_CASE` only
   for fixed values at the top of a file. Acronyms as words (`loadHttpUrl`).
5. Functions start with a verb. True/false values start with `is`, `has` or `can`. One
   idea keeps one name in every file.

This is Google's rule with two changes. We add the 4-word limit, because a name can be
too long as well as too short. And we allow a lone `_` for a parameter we don't use.
TypeScript's `noUnusedParameters` skips a name that starts with `_`, and `_` is the
common way to say "not used".

`test/architecture.test.ts` checks rules 2 and 3, and `CONSTANT_CASE` inside a function.
It reads every name declared in `src/` and `bin/`. Each failure says the file, the line,
the name, the reason and a fix. Rules 1 and 5 need judgement, so the reviewer holds them.

The test reads the code with a small tokenizer, not the TypeScript compiler. CI runs the
tests without `npm ci`, so the compiler is not there. TypeScript 7 also has no stable
compiler API for JavaScript. The tokenizer drops comments, strings and regular
expressions, then finds declarations by their shape. A positive control feeds it bad
names and expects a catch.

The test does not read `test/`. A test may keep a short name inside one `test()` block
when the 10-line rule holds. Many tests now use `s` and `r` across a long block. Moving
them to the rule is its own piece of work.

## Options not taken

- **A 20-character limit.** A limit on characters makes people cut words short. That is
  the problem rule 1 exists to stop. A word limit asks the right question: which words
  does the reader need?
- **No rule.** Names then drift one pull request at a time, and a new coder copies what
  they see.
- **Google's rule in full, with no `_` at all.** An unused parameter then needs a real
  name, and `noUnusedParameters` reports it. `_` says "not used" more clearly.
- **The TypeScript compiler in the test.** It is a dev dependency, and CI's test job does
  not install it. Adding `npm ci` there changes CI for one test.

## Consequences

- The names the test found are renamed. Behaviour and exported names do not change.
- The guide has a "Naming" section for learners, in English and in Chinese.
- The kit gets the same rule next (#110), and `check` gets a soft note for any project
  (#111). That note can reuse this tokenizer, since it too must run with no
  dependencies.
