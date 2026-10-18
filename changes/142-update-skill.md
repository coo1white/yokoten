Added

`/yokoten:update` in the Claude Code plugin. It shows what `yokoten update` would change
in the core rules of `AGENTS.md`, asks you, and writes only after you agree. It runs the
plugin's own yokoten, because the copy in `.yokoten/` has no kit to compare with (#142).
