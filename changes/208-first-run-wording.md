Fixed

First-run wording (#208). With no origin remote at all, `doctor` and `init` now say there is no
origin remote yet and to add one on GitHub, instead of "the origin remote is not on GitHub".
The doctor line for an unread server no longer says "can't check" twice. Right after `init`,
the `security-files` step says to choose a license, not that `init` adds the files it already
wrote. The README install steps say to commit with `TZ=UTC` before the first commit, and why.
