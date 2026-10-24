Added

`yokoten board` shows the picked agent's own session in the middle column, live, like a chat: what it says, and its tool calls folded into "Ran N steps · the last one". Click a step to see the whole call and its output. The board reads Claude Code, Muse Code and Grok logs, from the agent's worktree, and only the new lines on each read. Every line is masked first: the home folder, email addresses, tokens, keys and your private marks never leave the board. An agent with no log found shows its `doing` steps, as before (#694).
