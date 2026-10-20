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

With no setup, a private mark never blocks the repo it names (#447). If a mark is the name of
the repo's origin remote, `check`, the commit hook and `gh` posts skip that one mark there.
`Quiet Vale` names `someone/quiet-vale`: case aside, and `-`, `_`, `.` and spaces are word
breaks, so `Li Na` is not `lina`. Every other mark and every other repo is unchanged, and when yokoten
can't tell the repo it skips nothing. Only origin counts, and a later push to another remote is
not checked. `doctor` counts the marks skipped this way. `"privacy": { "skipOwnName": false }`
in yokoten.json turns it off for a repo, and `"skipOwnName": false` in the machine's allow file
turns it off for every repo on this machine. The allow above is for what this can't see.

A `gh` post now gets an allow only when its line holds plain text outside quotes: letters,
digits, spaces and `_ . / : , = + @ % -`, plus quoted text, one `cd` and one heredoc (#447).
Brace expansion such as `{--repo,x/y}`, globs and `$` could hide a target, so any of them gets
no allow. An origin that is a remote helper (`ext::`, `gcrypt::`) skips and allows nothing. An
origin on `localhost`, `127.x.x.x` or `::1` counts as a local folder. A machine allow file may
hold just `{ "skipOwnName": false }`.
