Added

`AGENTS.md` now names the kit version that wrote its core rules, in an HTML comment on
line 1 that `init` writes and `update --write` sets. When a project's kit is newer than the
yokoten you run, `update` refuses and writes nothing, and `doctor` says to update yokoten
itself, not the project. A file without the line compares by its text, as before (#141).
