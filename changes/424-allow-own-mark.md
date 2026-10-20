Fixed

A private project can now use its own name in its own repo (#424). List the name in
`privacy.allow` in that project's yokoten.json. A private mark that is the same string as an
entry there, upper or lower case aside, is then let through in that repo only. This holds for
`check`, the commit hook and the guard for `gh` posts. Every other repo with the same
private-marks file still stops it. A part or a longer string does not count. `doctor` says how
many marks the project allows, and never which.
