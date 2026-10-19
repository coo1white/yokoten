Added

`doctor` and the session doctor note when the enabled Claude Code plugin is older than the
yokoten that runs them: by its package version, or, in yokoten's own repo, by its commit behind
the default branch's tip. The note names the update command, `claude plugin update yokoten@yokoten`.
Its rule is `plugin-version`, so `yokoten explain plugin-version` says more. It never
fails doctor, and it says nothing when it can't compare offline (#198).
