Added

`yokoten uninstall` takes back what `install` wrote: the managed skills and agents, its
two hooks in `~/.claude/settings.json`, and `~/.local/share/yokoten`. It keeps your own
files, your other settings and `~/.config/yokoten`. With the Claude Code plugin on,
`doctor` now notes the pieces `install` left, which run every hook twice and show every
skill twice, and says to remove an old installed runtime instead of installing again
(#300).
