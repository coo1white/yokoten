Added

The tool-call guard refuses a `git commit` that adds a secret, a private email address or an IP address, even in a repo with no `yokoten init`: it reads the staged diff as text (binary files too), and with `-a` the tracked changes, and names the file and line, never the secret. A commit whose change it cannot read is refused, never allowed (#824).
