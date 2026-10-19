Added

`init` writes Muse Code's tool-call guard and stop check into `.muse/hooks.json`, and keeps the hooks already there.
Muse runs them only in a folder you trust; `doctor` notes them as `muse-hook`.
Muse passes no `YOKOTEN_ROLE` to a hook, so every Muse session counts as the lead (#5).
