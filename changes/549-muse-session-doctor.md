Fixed

`yokoten doctor` now checks the Muse Code session-start doctor in `.muse/hooks.json`, next to the tool-call guard and stop check (#549). A project set up before that hook existed hears about it, and `yokoten init` adds it.

On a machine where Muse Code is the only agent folder there, full `doctor` now gives the same note a Muse session already gets: command output is not filtered, and `privacy.output` can stop it (#549).
