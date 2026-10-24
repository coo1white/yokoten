Added

`yokoten conflicts` says which open changes collide, and what to merge first (#909).
It reads every open pull request, or every local branch when there is no host.
It names the pairs that touch one file, and which of the two goes first.
It checks nothing out and merges nothing, and keeps the map in the git folder.
The session-start doctor says one line when changes collide or the map is old.
