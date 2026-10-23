---
name: doctor
description: Show where this project is on the yokoten road, and the one next step. Use when the user asks what the project is missing, or what to do next.
argument-hint: "[--json]"
---

> **Skills-only copy?** `npx skills add` copies the skills alone: no guard and no session
> doctor. When `yokoten` is not on PATH and the Claude Code plugin is not enabled, say one
> line. Then carry on: "This copy has the skills only; run `npx yokoten install` to add the guard."

# Run yokoten doctor from the plugin

1. Go to the root of the repo.
2. Run this with the Bash tool:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/yokoten.ts" doctor $ARGUMENTS
   ```

3. Tell the user the stage and the one next step, in plain words. Offer to do that step:
   as-is, lighter, or not now with a reason.

Doctor exits 1 while a step is left. That is a report, not an error.
