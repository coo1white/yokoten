Changed

`init` now updates a CI workflow from the kit that you never changed (#456).
The kit keeps a list of every version of its workflows. When your
`.github/workflows/yokoten.yml`, `pr.yml` or `issue.yml` matches one of them, `init`
puts in the newest version and says so. Windows line ends stay as they were.
`init` never commits, so `git restore <file>` brings the old one back.
A workflow with your changes is kept. `init` and full `doctor` show a command that
compares it with the kit's newest copy. A symlink is never written through.
The copy in `.yokoten/` now also holds the kit's workflows, for that command.
