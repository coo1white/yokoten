Added

`yokoten init` now adds a SessionStart hook to `.muse/hooks.json`. Muse Code runs `yokoten doctor --session` at the start of a session and shows the next step to the model. An existing file keeps your own hooks. Running `init` again adds the hook only once (#556).
