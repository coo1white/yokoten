Fixed

`install` run from `~/.local/share/yokoten`, or `init` run from a project's `.yokoten/`,
no longer deletes the copy it runs from: it keeps that copy and says so. Any other copy
is written next to the old one first and then swapped in, so a failed copy leaves the old
one working. When the runtime is missing, the hooks and the commit check say one plain
line that names no full path, instead of a Node stack trace (#204).
