Fixed

The guard no longer reads a shell redirect as a new core.hooksPath value. So `git config core.hooksPath 2>/dev/null` passes as the read it is (#351). A quoted value such as `">x"` is still a value, and a change is still refused.
