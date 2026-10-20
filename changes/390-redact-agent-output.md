Added

Agents read command output with your details hidden (#390). `yokoten redact` puts
placeholders in place of secrets, your private marks, emails, git name and private hosts,
and passes output through unchanged if it can't start. In Claude Code, the tool-call guard
sends a plain read that prints account details (`git log`, `git remote -v`, `gh auth
status` and others) through it. Other agents run the command as it is, unless
`privacy.output` is `"stop"` in `yokoten.json`. `install` sets a git mailmap outside every
repo, and `install` and `doctor` add the marks they find on this machine. Not hidden: push
and fetch errors, files an agent reads (such as CODEOWNERS), and `env`.
