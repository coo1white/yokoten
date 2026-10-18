Added

Each pull request adds its own file, `changes/<issue>-<slug>.md`, instead of a line in
`CHANGELOG.md`, so two pull requests never conflict on the changelog. Line 1 is the
section and line 3 starts the entry. `yokoten changelog` shows what the files add, and
`yokoten changelog --write` moves them into `CHANGELOG.md` and deletes them, before a
release. `check --pr` takes a change file in place of a changelog line and checks its
form (`change-file`); a line in `CHANGELOG.md` still passes. `doctor`'s changelog step
passes with a `changes/` folder, and `changes/` may hold more than 7 files. **Kit
change:** `init` adds `changes/README.md` (#132).
