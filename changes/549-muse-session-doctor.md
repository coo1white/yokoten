Fixed

`yokoten doctor` now checks the Muse Code session-start doctor in `.muse/hooks.json`, next to the tool-call guard and stop check (#549). A project set up before that hook existed hears about it, and `yokoten init` adds it.
