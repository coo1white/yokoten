Fixed

`check --history` no longer misses a commit hidden by `git replace`. Replace refs are
pushed and fetched like any ref, so the hidden commit is still public; the check now reads
the commits as they are, past any replacement. A `.git/info/grafts` file can hide commits
the same way, so with one there the check scans nothing and fails with one finding,
`shallow-history`, which says to run `git replace --convert-graft-file` and check again
(#284).
