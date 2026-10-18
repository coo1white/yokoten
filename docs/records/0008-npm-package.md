# 0008 The npm package ships built JavaScript

Status: accepted; changes the "compile" option of [0002](0002-typescript.md) for the npm package
Date: 2026-10-18 (UTC)

## Context

A one-command install is the biggest gap for a new user (#31). `npx yokoten` is the
command people expect. But Node does not strip types from `.ts` files under
`node_modules`, so a package of `.ts` files can't run there.

## Decision

- The npm package runs `.js` from `dist/`, which `tsc` builds with
  `tsconfig.build.json`. `npm pack` builds it first, in the `prepack` script.
  `dist/` is git-ignored.
- The repo has no build. Source, tests, hooks and the plugin still run `.ts` as it is.
- The package also ships `bin/`, `src/` and `kit/`. `install` and `init` copy the `.ts`
  runtime out of the package. The copies are not under `node_modules`, so Node runs
  them. The hooks keep one path: `bin/yokoten.ts`.
- Still no runtime dependencies. `test/architecture.test.ts` holds this.
- The owner publishes the package, as the owner creates a tag (core rule 3).

## Options not taken

- **Strip the types with `module.stripTypeScriptTypes` and rewrite the imports.** A
  build made by hand, on an API Node still marks experimental. `tsc` is already a dev
  dependency, and it rewrites `.ts` imports itself (`rewriteRelativeImportExtensions`).
- **Copy the built `.js` into `.yokoten/` too.** Then the vendored copy is not the
  code in the repo, and every hook path changes.
- **The Claude Code plugin only.** It serves Claude Code alone, not Codex CLI or
  Gemini CLI.

## Consequences

- `npm run check-package` packs the package, installs the tarball offline, and runs
  `install`, `init` and `doctor` with a temporary home folder. It needs `npm ci`
  first, for `tsc`.
- The package holds the code twice, as `.ts` and as `.js`. It is about 160 kB.
