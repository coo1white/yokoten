# 0024 How we borrow: check first, pick one of three roads, keep the fence and the source

Status: accepted
Date: 2026-10-22 (UTC)

## Context

Record 0023 says yokoten does what other multi-agent tools do well. That leaves the
question of how: write everything from nothing, or take what exists.

yokoten has limits that rule out most taking. It is TypeScript run by Node with no
runtime dependencies, no Docker and no server (records 0020 and 0015). So a package from
npm, or a tool that runs its own server, cannot come in whole, even with a good license.

The language is not the limit. Of the projects yokoten learns from, Gemini CLI, the MCP
SDK and the A2A JavaScript SDK are TypeScript; Codex CLI is Rust and Gas Town is Go.

On 2026-10-22 the owner added: prefer tools from large vendors, and projects that many
people use and that are still active. A project that has not changed for months is
something to read, not something to build on. Checking on 2026-10-22 showed why: one
project we had been citing had not been pushed to in ten months, and GitHub could not
name its license.

## Decision

Every borrowed piece, a "wheel", goes the same way, whoever does the work.

1. **Check first, in the issue.** The issue names the problem, the projects looked at
   with their stars, last push and license (from the host's API, not from memory), the
   road chosen, and the failure the work fences off (record 0023). Large vendors and
   active, widely used projects come first.
2. **One of three roads.**
   - **Only the idea** (the usual case): we write the code. The pull request says where
     the idea came from.
   - **Code under a permissive license** (MIT, BSD, ISC, Apache-2.0): copy only the part
     needed, into `src/borrowed/`, never as an npm dependency. Each file starts with the
     source URL and the commit it was taken from, keeps the copyright notice (and the
     NOTICE for Apache-2.0), and marks what we changed.
   - **Code under an unclear or restrictive license:** clean-room. One agent reads the
     source and writes a description of what it does, with no code. An agent from another
     vendor, which has not seen the source, writes the code from that description.
3. **The fence ships with the wheel.** Tests come first, the first version is the
   smallest that works, and the safety part is in the same pull request. An agent from
   another vendor reviews; security work is reviewed by the strongest model (record 0021).
4. **Borrowed code is watched.** `yokoten check` refuses a file in `src/borrowed/` with no
   source, commit or notice. A scheduled job compares each source with its upstream and
   opens an issue when upstream fixes a bug or a security hole.

## Options not taken

- **Write everything from nothing.** Throws away tested work and repeats others' bugs.
- **Take whole projects as dependencies.** Breaks the no-dependency and no-server
  promises, and brings a supply chain yokoten cannot check.
- **Change language to borrow more** (Rust or Go). The tools closest to ours are
  TypeScript already; a rewrite costs months and gains little.

## Consequences

- Each wheel costs one look at its sources before any code is written.
- `src/borrowed/` is the seventh entry in `src/`, at the folder cap.
- The check and the upstream watch run (#676): `yokoten check` refuses a wheel with no
  source, commit, license or notice, and the `borrowed` job opens one issue when upstream
  moves.
