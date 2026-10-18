Added

A project can block programs in `yokoten.json` under `"commands": { "block": { "<program>": "<reason>" } }`.
The tool-call guard then stops a command that runs one of them, by name, with any folder or `.exe`,
in any part of the command: after shell keywords (`then`, `do`, `!`), after `env`, `sudo`, `nice`,
`stdbuf`, `setsid` and other launchers, after `find -exec`, and in the string `env -S` runs. It gives
the reason from `yokoten.json`, for every role. A wrong shape is a config error for `check`;
the hook then drops only the list, says so once, and keeps its core checks. This repo blocks
`python` and `python3` (#192).
