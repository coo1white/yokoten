Added

`yokoten conflicts` now offers a rebuild when a change conflicts with main (#913). It writes a prompt to paste into an AI: keep the old commits as `old-work`, start the branch again from today's main, and make the same change there. The rebuilt branch pushes with `--force-with-lease` on the head it started from, so a branch that moved is refused.
