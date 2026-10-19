Added

The tool-call guard now runs in Antigravity CLI (`agy`): `init` writes `.agents/hooks.json`, and `doctor` checks it.
A refused call also puts its reason on stdout, so GitHub Copilot CLI tells the agent why.
`.agents/hooks.json` is lead-only by default, so a worker can't turn that guard off.
The guide lists each agent with the real run that blocked `git push --tags`: Claude Code, Copilot CLI, Antigravity CLI and Codex.
Gemini CLI is marked not run end to end, since personal Google sign-in for it ended (#30).
