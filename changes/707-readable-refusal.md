Changed

A refusal now reads the same everywhere: `yokoten stopped this: <what> [<rule>]`, then `Why:`, `Do instead:` and `More:`. Claude Code gets it as a deny in JSON, so its "hook error" line and the shell wrapper are gone. On a terminal, `yokoten doctor` and other commands use colour and lined-up columns, and `NO_COLOR` turns the colour off. The board draws a refusal by the same parts. `YOKOTEN_HOOK_DENIAL=exit2` keeps the older hook answer. (#707)
