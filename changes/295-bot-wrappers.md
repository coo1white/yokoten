Fixed

The bot runs only `gh` and `git` (by base name, so `gh.exe` and `/usr/bin/gh` count). A
wrapper such as `env gh …` or `sh -c "gh …"` is refused before a token is asked for, since
it would send a title unchecked. `gh api` on an issue or pull request path now checks a
`title=` field by the issue or pull request rule, and `-t=X` is read as the title `X`, as
gh reads it. A gh alias is not read; the guide says so (#295).
