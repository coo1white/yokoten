Fixed

`yokoten redact` and upstream notes now hide your Linux user name, and in WSL your Windows
user name (#404). This works also when git and gh do not know them. `/mnt/c/Users/<name>`,
`C:\Users\<name>` and the same paths in a URL (`C:%5CUsers%5C<name>`) then become `<owner>`.
A path in your home now becomes `~/x`, not `/home/<owner>/x`. A home path that a line cuts
short (4 or more letters of the name) is hidden too. In WSL, yokoten reads the Windows user
names from the Windows drives at most once in 30 days, and keeps them in
`~/.config/yokoten/machine.json`. Shared and service accounts (root, test, Public) are not
hidden, so common words stay readable. `install` and `uninstall` stop when they find no home
folder, instead of writing into the current folder; `doctor` says so in one note.
