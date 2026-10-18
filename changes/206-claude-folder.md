Fixed

A `.claude/CLAUDE.md` now counts as a CLAUDE.md. Claude Code reads it instead of
`AGENTS.md`, so `init` adds `@../AGENTS.md` to it when there is no root `CLAUDE.md`, and
doctor's `rules` step and `adopt` want that line. Before, such a project was told
`AGENTS.md` was read when it was not (#206).
