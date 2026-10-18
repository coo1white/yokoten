Fixed

A key in `yokoten.json` with the wrong shape, such as `"leadOnly": "x"` or `"layout": { "maxEntries": "7" }`, no longer crashes the tool-call hook and turns the guard off. yokoten checks every key against one table. `check` and `doctor` report a wrong key as a config error that names the key and says what it must look like. The hook uses that key's default, says so in one line, and still runs the core checks. A key yokoten does not know is a note from `check`, not an error (#228).
