---
name: init
description: Put the yokoten practices into this project. Use when the user asks to set up or adopt yokoten here, or when the session start says `yokoten init` adds a missing step.
argument-hint: "[--github [--yes]]"
---

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Run yokoten init from the plugin

1. Go to the root of the repo.
2. Run this with the Bash tool:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/yokoten.ts" init $ARGUMENTS
   ```

3. Show the user what it reports. `init` only adds files. It keeps every file that is
   already there, and says so.
4. `init` writes `.yokoten/`, a copy of yokoten that the project's hooks and CI run. Tell
   the user to commit it.
5. A project that had its own rules before: use the `yokoten` skill next, and go through
   each practice with the user.

After `init`, the project's own copy runs the other commands:
`node .yokoten/bin/yokoten.ts check`.
