Fixed

In Codex, a worker could change a lead-only file with `apply_patch` run through the shell,
because Codex sends that as a shell call and the hook checked only the command. The hook
now also checks the files the patch touches (#209).
