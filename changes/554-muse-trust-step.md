Fixed

`yokoten doctor` now shows a step when Muse Code does not trust the folder. This is the `tool-hook` step. It applies when the project has `.muse/hooks.json`. Before, Muse skipped the guard and doctor showed only a note. The step says to run `muse` here and choose "Trust and continue". It also says you can pass `--trust-workspace` to `muse exec` (#554).
