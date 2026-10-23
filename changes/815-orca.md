Security

A repo with no `yokoten.json` now keeps its CI files and git hooks: the guard refuses a shell write to `.github/workflows`, `.github/actions`, `.githooks` or `.husky`, for the lead too (record 0034, #815).
A commit that changes one is refused as well. A read passes.
`yokoten init` adds the project's own rules, and then the lead decides.
The guide has a new section, "Under Orca": install the plugin, what Bypass Permissions mode turns off, and what the Windows trial showed (English and zh-CN).
The board lists Orca's worktrees under `~/orca/workspaces/<repo>/<name>` with the repo's own worktrees.
