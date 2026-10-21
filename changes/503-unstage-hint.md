Fixed

When the commit check stops a commit, it now says how to take the stopped files out of it. The message gives the command `git restore --staged <file>` for the files it names. It says the files stay on disk. In a repo with no commit yet, the command is `git rm --cached` (#503).
