Added

The last line of a pull request may name the reviewers: `🤖 Made with worker <X> (<model>), reviewed by <Y> (<model>) and <Z> (<model>), lead Claude Code (<model>)`. One or two reviewers are allowed, and old lines still pass. A malformed `reviewed by` part is reported with how to fix it. The dispatch and inspect skills and the pull request template tell agents to add each reviewer (#673).
