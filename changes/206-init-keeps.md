Fixed

`init` no longer turns off a project's own setup without a word. With a `CLAUDE.md`, it
adds an `@AGENTS.md` line, because Claude Code reads `AGENTS.md` only through it; doctor's
`rules` step now wants that line. With husky or another `core.hooksPath`, it keeps that
folder and adds the commit check to its `pre-commit`, keeping the project's own lines,
instead of switching git to `.githooks`. Doctor's `commit-check` step accepts the check in
the hook that git really runs (#206).
