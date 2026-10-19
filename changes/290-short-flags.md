Fixed

The bot now reads a title or label in short flags run together, as gh does: `gh pr create -dt X`,
`-dtX` and `-dlbug -t X` are checked like `--title X`. A run-together word with a letter
gh's create and edit don't have is refused with "can't read the title", so a title is never
sent unchecked (#290).
