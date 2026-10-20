Added

`yokoten learn --upstream "<what happened>"` keeps a note about a gap in yokoten itself,
found in any project, in `~/.config/yokoten/upstream/`, outside every repo. The
project's name and folder become `<project>`, the home folder `~`, and the owner is hidden
as `yokoten redact` hides them; a note that still holds a secret, an email address, an IP
address or a private mark is not kept. In the yokoten repo only, the session start and
`doctor` count the notes that wait. `--list` shows them and `--done <id>` removes one. The
`rca` skill asks whether the cause is in yokoten itself (#392).
