Fixed

The guard now refuses `git tag <name>` and `git tag -a/-s` for every agent, not only a tag push: only the owner creates a tag (#812). A listing still passes, combined flags included (`git tag -l`, `git tag -ln`).
