Internal

No test reads or writes your real home folder or `~/.config/yokoten`, even when you run
`node --test` without `HOME=$(mktemp -d)` (#356). Each test file first loads
`test/repo/home.ts`, which points HOME at an empty temp folder. The architecture test checks
that, and that no child process gets an env with no HOME. In `src`, a function reads the
home folder only from the env it is given; only the CLI's entry falls back to the system's
home when HOME is empty.
