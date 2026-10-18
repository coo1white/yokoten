---
name: update
description: Bring the core rules in this project's AGENTS.md up to date with yokoten. Use when doctor reports `core-rules`, or when the user asks to update the rules.
---

# Run yokoten update from the plugin

The plugin runs its own copy of yokoten. That copy has the kit, so it can compare. The
copy in `.yokoten/` has no kit, so do not run `update` from it.

1. Go to the root of the repo.
2. Preview the change with the Bash tool. This writes nothing:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/yokoten.ts" update
   ```

3. If it says the rules are up to date, or it can't compare, tell the user and stop.
4. Show the user the sections that change and the lines marked `+` and `-`. A line
   marked `-` is replaced. It can be a rule the user wrote by hand. Offer to move such a
   rule under `## This project` first.
5. Ask the user if they want the change. Write only after a clear yes:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/yokoten.ts" update --write
   ```

6. Tell the user what changed. Everything from `## This project` down stays the same.
   Offer to commit `AGENTS.md`.
