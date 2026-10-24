Added

`install` now writes the user-level command guard for Antigravity CLI and Copilot CLI (#342).
For agy it goes in `~/.gemini/config/hooks.json`, and for Copilot in `~/.copilot/hooks/yokoten.json`.
Both files run in every workspace, so a repo without yokoten is guarded too.
`uninstall` removes the guard and keeps the user's own entries.
`doctor` notes a missing or out-of-date guard when that CLI's folder exists.
Neither agent gets a stop check yet: agy has no re-entry signal, and Copilot lets a timed-out hook go on.
