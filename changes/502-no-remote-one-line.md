Fixed

In a repo with no origin remote, doctor now shows one line instead of one for each step that reads the server. The line names the steps it can't check yet. It gives the command that adds the remote: `git remote add origin <url>` (#502).
