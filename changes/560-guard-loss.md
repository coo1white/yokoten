Added

The command guard refuses work-losing commands: an `alias`, removing `.git`,
deleting the default branch (`git branch -D`, `git update-ref -d`,
`git push --delete`) and piping a download into a shell (`curl ... | sh`).
Each refusal names the safe way instead (#560).
