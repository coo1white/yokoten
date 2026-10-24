Changed

`init` now writes a `check` workflow that also runs the released yokoten Action,
`yokoten-labs/yokoten@<commit>`, pinned to the v0.1.0 commit (#129). Dependabot keeps
the pin current. The project's copy in `.yokoten/` still runs first: it is the same
yokoten as the commit hook, so a commit made with `--no-verify` meets the same check
in CI (core rule 6). The action adds a check a pull request cannot edit by changing
`.yokoten/`. The `pr` and `issue` workflows run the project's copy only.
