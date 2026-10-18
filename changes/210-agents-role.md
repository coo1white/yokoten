Fixed

The Gemini CLI hook that `init` writes now runs in a repo whose path has a space. Gemini
quotes `$GEMINI_PROJECT_DIR` itself, so the command no longer adds quotes of its own, and
`init` updates an older hook in place; before, the hook failed and Gemini let the call
through. The guide says to start Gemini at the repo root. In Codex, a subagent whose
`agent_type` names a worker now counts as a worker without `YOKOTEN_ROLE` (#210).
