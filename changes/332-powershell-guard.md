Added

The tool-call guard reads PowerShell commands, not only POSIX shell. `;`, `|`, `&&`, quoting, `{ … }` script blocks, `Remove-Item -Recurse -Force`, and `git push --tags` inside a block now answer to the same rules (#332). Some commands it cannot read: a write whose target is a variable or a script file, or an unknown cmdlet that changes something. The guard refuses those instead of letting them through.
