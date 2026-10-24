Changed

`yokoten bot -- gh pr edit` adds the type label a new title names, and the tier label a new body names. It removes the old tier label only when the new one is in place: added by the command or the bot, or already on the pull request. A tier label the repo does not have is left out, and the old tier label stays. A label you pass is kept (#422). When gh cannot read the pull request's labels, the edit still goes: the new tier label is added, and a note says an older tier label may stay next to it, with `--remove-label` to drop it. Two tier labels fail `check --pr`.
