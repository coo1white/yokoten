Changed

`init` now writes a `check` workflow that uses the released yokoten Action,
`yokoten-labs/yokoten@<commit>`, pinned to the v0.1.0 commit (#129).
Dependabot keeps the pin current. The `pr` and `issue` workflows still run the project's
copy in `.yokoten/`.
