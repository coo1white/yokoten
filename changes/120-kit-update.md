Added

`yokoten update` brings the core rules in a project's `AGENTS.md` up to the kit's.
It shows the change and writes nothing. `--write` replaces the part above
`## This project`, and keeps the project's own part byte for byte. `doctor` reports
`core-rules` when the core rules differ, and a session hears it too. Without a
`## This project` heading, it says it can't compare, as a note. Before this, a lesson
added to the kit never reached a project that had already run `init` (#120).
