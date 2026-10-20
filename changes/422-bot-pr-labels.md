Added

`yokoten bot -- gh pr create` now adds the type and tier labels that `check --pr` asks for
when the command leaves them out (#422). The type label comes from the title (`bug` for
`fix`), and the tier label from the body's `tier:` line. A label you pass is kept, and is
not added twice. A tier label that does not match the body is refused before anything is
sent, with the message `check --pr` gives. The bot uses the names the repo has (such as
`enhancement` or `tier: B`). A label the repo does not have is named in a note and left
out; the bot never creates labels.
