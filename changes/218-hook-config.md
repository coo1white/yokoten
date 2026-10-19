Fixed

The tool-call hook no longer turns itself off when `yokoten.json` is broken. On a file that is not valid JSON, is not one JSON object, or cannot be read, the hook uses the defaults, prints one line that names the file and the problem, and still runs the core checks. `check` and `doctor` still report a config error and exit 1. The hook also judges a command in the folder the agent runs it in, so a hooks setting is read from that repo (#218).
