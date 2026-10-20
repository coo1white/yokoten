Added

`yokoten learn --upstream "<what happened>"` keeps a note about a gap in yokoten itself,
found in any project, in `~/.config/yokoten/upstream/`, outside every repo. The
project's name (in any spelling) and its paths (through symlinks too) become `<project>`,
the home folder `~`, and the owner is hidden as `yokoten redact` hides them, an email
address as `<email>`. A note with a known secret shape, or an IP address or private mark
left after that, is not kept; with no home folder, nothing is kept. In the yokoten repo only, the session start and
`doctor` count the notes that wait. `--list` shows them and `--done <id>` removes one. The
`rca` skill asks whether the cause is in yokoten itself (#392).
