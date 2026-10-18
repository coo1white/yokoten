Fixed

In Codex, a worker could change a lead-only file with `apply_patch` run through the shell,
because Codex sends that as a shell call and the hook checked only the command. The hook
now also checks the files the patch touches, from the session folder and from every folder
the command changes to with `cd` or `pushd` (#209).
