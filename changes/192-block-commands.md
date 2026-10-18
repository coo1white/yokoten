Added

A project can block programs in `yokoten.json` under `"commands": { "block": { "<program>": "<reason>" } }`.
The tool-call guard then stops a command that runs one of them, by name, with any folder or `.exe`,
in any part of the command and after `env`, `sudo`, `nice` and other wrappers. It gives the reason
from `yokoten.json`, for every role. A wrong shape is a config error. This repo blocks `python` and
`python3` (#192).
