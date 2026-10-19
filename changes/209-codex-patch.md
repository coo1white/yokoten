Fixed

In Codex, a worker could change a lead-only file with `apply_patch` run through the shell,
because Codex sends that as a shell call and the hook checked only the command. Now, when a
shell command names `apply_patch`, the hook also checks every file header in it. It reads each
path from the session folder, from every folder the command changes to (`cd`, `pushd`,
`env -C`), and, after a change to a folder it cannot know, from each folder above (#209).
