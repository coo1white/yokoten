Fixed

`yokoten redact` and upstream notes now hide your Linux user name, and in WSL your Windows
user name (#404). This works also when git and gh do not know them. `/mnt/c/Users/<name>` and
`C:\Users\<name>` then become `<owner>`. A path in your home now becomes `~/x`, not
`/home/<owner>/x`. A home path that a line cuts short (4 or more letters of the name) is
hidden too. In WSL, yokoten reads the Windows user names once from the Windows drives and
keeps them in `~/.config/yokoten/machine.json`. `install` stops when it finds no home
folder, instead of writing into the current folder.
