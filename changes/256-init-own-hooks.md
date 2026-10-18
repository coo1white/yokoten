Fixed

`init` no longer switches off a clone's own hooks in `.git/hooks`, such as lefthook, the
pre-commit framework or a hand-written hook. It writes `.githooks/pre-commit` and
`.githooks/pre-merge-commit` to run the commit check first and then the old hook, with the
same arguments, when it is executable. The old hook stays where it is, and `init` says
which ones it kept, with a note when `lefthook.yml` or `.pre-commit-config.yaml` is there.
When it can't hand off (the hook is not executable, or it comes from a global
`core.hooksPath`), `init` leaves `core.hooksPath` unset and prints what to do. `doctor`
no longer counts the commit check as done while such a hook would be dropped, and running
`init` again repairs a clone that an older `init` set up. A `.githooks/pre-commit` of the
project's own now gets the check, so `doctor`'s advice comes true. For a `pr.yml` or
`yokoten.yml` of the project's own, `doctor` gives the step to add instead of saying
`init` adds the file. `init` no longer runs `chmod 755` on a hook it keeps: it adds the
execute bit only when git would skip the hook, and never under `.husky/` (#256).
