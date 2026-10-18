# 0002 TypeScript, run by Node as it is

Status: accepted; changes point 6 of [0001](0001-yokoten.md); the npm package changed by [0008](0008-npm-package.md)
Date: 2026-10-18 (UTC)

## Context

0001 chose plain `.mjs` so the hooks run on a fresh machine with nothing installed.
That still holds. But the code passes config, environments and tool calls between
modules, and plain JavaScript says nothing about their shape: a renamed field fails at
run time, in a hook, on someone else's machine.

Since 22.18, Node runs `.ts` files itself by stripping the types. No build, no loader.

## Decision

- Source and tests are `.ts`, and Node runs them as they are. The hooks, the vendored
  `.yokoten/` copy and the machine copy all run `bin/yokoten.ts`.
- Only syntax Node can erase (`erasableSyntaxOnly`): no `enum`, `namespace` or
  parameter properties. Imports name the `.ts` file.
- Still no runtime dependencies. `typescript` and `@types/node` are dev dependencies,
  used only by `tsc --noEmit` in CI.
- Node 22.18 or later.

## Options not taken

- **Bun.** It runs TypeScript too, but every machine and every adopting project would
  need it installed, and Node is already there.
- **Compile to JavaScript.** A build step means the committed code is not the code that
  runs, and a vendored copy must be rebuilt. Not needed while Node strips types.
- **Stay on `.mjs` with JSDoc types.** Checks the same, reads worse.

## Consequences

- A machine with Node older than 22.18 cannot run yokoten. Node 22 is the oldest line
  still supported, and its current releases are well past 22.18.
- Node does not strip types under `node_modules`, so publishing to npm would need a
  build step then. [0008](0008-npm-package.md) adds that build, for the package only.
