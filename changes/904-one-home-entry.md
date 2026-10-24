Changed

`yokoten install` leaves one global entry skill, not seven, and writes nothing global when the Claude Code plugin is on; with the plugin it also takes back the copies an older install left. It prints the files and settings keys it will touch, and `yokoten uninstall` restores the home folder, including the hooks of every agent tool (#904).

Without the plugin, install still writes the three agents in the global folder, beside the one entry skill. With the plugin on, install writes no guard of its own: the plugin's guard is the one guard. The owner decided both on 2026-10-24. Turn the plugin off or remove it, and the machine is left with no guard at all. `yokoten doctor` and a session start then fail with "no guard for Claude Code", and `yokoten install` writes install's own guard.
