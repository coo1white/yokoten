Added

Agents read command output with your details hidden (#390). `yokoten redact` puts
placeholders in place of your private marks, emails, git name and private hosts. In Claude
Code, the tool-call guard sends commands that print account details through it. A read runs
at once; a push or a deploy still asks you. Other agents run the command as it is, unless
`privacy.output` is `"stop"` in `yokoten.json`. `install` sets a git mailmap outside
every repo, and `install` and `doctor` add the marks they find on this machine.
