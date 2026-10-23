Changed

The board shows every agent's session in one shape (#698).
The agent's words are the main text.
Each tool is one short line, and a long run of steps folds after three.
Claude, Grok, Muse and DeepSeek all use that shape.
DeepSeek is read from its Codex log.
A Codex shell, patch or search call becomes the same step, and a failed command shows as failed.
The bottom bar shows how many seats are free, per vendor and in total.
The seats come from `.git/yokoten-seats.json` when that file exists; without it the bar counts idle agents.
A vendor's square breathes while one of its agents is working.
A stopped agent does not keep a seat.
