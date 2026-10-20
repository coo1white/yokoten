Added

A repo with no yokoten.json can now let one of your private marks through, too (#447). Run
`yokoten marks allow <mark> --here` in that repo. The allow is kept on this machine, beside
the private-marks file, for that repo only, by its origin remote. Nothing is written into the
repo, so it stays commands-only and never names yokoten. `check`, the commit hook and the
guard for `gh` posts then let the mark through there, and every other repo still stops it. A
repo with no origin can't have this allow. A renamed remote is another repo. yokoten allows
nothing when a post or a push may go elsewhere. That is another remote besides origin, a gh
default repo, a push default, or origin addresses that name different repos. A `gh` post
gets neither this allow nor `privacy.allow` when it names another target (`-R`, `--repo`, an
issue URL, `GH_REPO`, `GH_HOST`, `gh api`, `gh gist`). The same holds when it is not the only
command on its line; one `cd` within the same repo before it is fine. When it allows nothing,
`doctor` says why. `doctor` counts the marks allowed here and says where the allow comes from, never which marks.
`yokoten marks allow --remove <mark> --here` takes it back.
