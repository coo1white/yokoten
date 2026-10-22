Added

`yokoten board` shows the team on a live page on this machine: each agent, each pull request stage, and each worktree. `yokoten board --text` prints the same data as plain text. The printed link holds a random token, and the board answers only its own host, so no other page can read it. The page shows the agents on the left, grouped by issue. The middle shows the picked agent. The right shows the pull requests with their checks. Each agent names its role: engineer, reviewer or verifier (#601).
