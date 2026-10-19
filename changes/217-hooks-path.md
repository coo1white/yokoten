Fixed

The tool-call guard no longer refuses a project's own hooks folder. Every read of core.hooksPath passes. In the repo's own config, `git config` may set the value already set, or a folder whose pre-commit runs `yokoten check`: husky's `.husky/_` counts when `.husky/pre-commit` runs it. `--unset`, `--global`, `--system`, a folder without the check, and `git -c core.hooksPath=...` stay refused. The refusal says which pre-commit needs the check (#217).
