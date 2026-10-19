Added

`/yokoten:update` in the Claude Code plugin. It shows what `yokoten update` would change
in the core rules of `AGENTS.md`, asks you, and writes only after you agree. It runs the
plugin's own yokoten. The copy in `.yokoten/` holds the kit's core rules too, but only as
new as the day `init` wrote them, so from there `update` finds nothing newer (#142).
