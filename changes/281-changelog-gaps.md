Fixed

A change file can no longer break `CHANGELOG.md` or the release. A heading in the entry
is refused, so a pull request can no longer add a fake version. `changelog --write` keeps
a CRLF `CHANGELOG.md` CRLF. `check --pr` flags a new file in a folder inside `changes/`,
which the release would refuse, and `changelog` gives a finding for a link in `changes/`
instead of crashing on a dangling one (#281).
