Fixed

`yokoten bot` now says why when the command does not run: `could not run <file>: ENOENT`
for a command that is not there, and which signal ended it when one did, with exit 1.
Before, it exited 1 and printed nothing, so a typo such as `ghh` gave no reason (#282).
