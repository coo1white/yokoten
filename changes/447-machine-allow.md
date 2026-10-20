Added

A repo with no yokoten.json can now let one of your private marks through, too (#447). Run
`yokoten marks allow <mark> --here` in that repo. The allow is kept on this machine, beside
the private-marks file, for that repo only: its origin remote, or its folder when it has no
remote. Nothing is written into the repo, so it stays commands-only and never names yokoten.
`check`, the commit hook and the guard for `gh` posts then let the mark through there, and
every other repo still stops it. A renamed remote is another repo. When yokoten can't tell
which repo it is in, it allows nothing, and `doctor` says why. `doctor` counts the marks
allowed here and says whether the allow comes from yokoten.json or this machine, never
which marks. `yokoten marks allow --remove <mark> --here` takes it back.
