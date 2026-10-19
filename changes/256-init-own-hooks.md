Fixed

`init` no longer switches off a clone's own hooks in `.git/hooks`, such as lefthook, the
pre-commit framework or a hand-written hook. It writes `.githooks/pre-commit` and
`.githooks/pre-merge-commit` to run the commit check first and then the old hook, and for
every other executable hook (`commit-msg`, `pre-push`, `post-checkout` and so on) a
`.githooks` file that only runs the old one, with the same arguments and stdin. The old
hooks stay where they are, and `init` names each one it kept; with `lefthook.yml` or
`.pre-commit-config.yaml` there, a note lists exactly the hooks it hands off to. The
hand-off skips a hook that is the running file itself, so a link back to `.githooks` does
not loop, and no variable switches it off. A hook git skips for lack of the execute bit
does not hold the check back: `init` sets `core.hooksPath` and says how to keep it. With a
global `core.hooksPath`, the files in `.git/hooks` never ran, so they are left out. When
it can't hand off (a commit hook from a global `core.hooksPath`, a `.githooks` hook of the
project's own whose check is not a plain line at column 0, or one that reads stdin like
the old hook), `init` leaves `core.hooksPath` unset and prints what to do. `doctor` no
longer counts the commit check as done while such a hook would be dropped, and running
`init` again repairs a clone that an older `init` set up. A `.githooks/pre-commit` of the
project's own now gets the check, so `doctor`'s advice comes true. For a `pr.yml` or
`yokoten.yml` of the project's own, `doctor` gives the step to add instead of saying
`init` adds the file. `init` no longer runs `chmod 755` on a hook it keeps: it adds the
execute bit only when git would skip the hook, and never under `.husky/` (#256).
