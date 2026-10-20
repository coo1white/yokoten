Added

`install` puts a `yokoten` launcher in `~/.local/bin` (`yokoten.cmd` on Windows), so `yokoten` works in the next shell (#433).
The launcher runs `bin/yokoten.mjs`, the same entry the hooks run.
When that folder is not on your PATH, `install` asks once before it adds one marked line to `~/.bashrc` or `~/.zshrc`. It never asks, and never edits, with no terminal.
A `~/.local/bin/yokoten` that yokoten did not write is kept and named.
`uninstall` removes the launcher and the marked line. `doctor` notes when no `yokoten` on your PATH runs the installed copy.
