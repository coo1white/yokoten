Added

Agents read command output with your details hidden (#390). `yokoten redact` puts
placeholders in place of your private marks, emails, git name and private hosts. In Claude
Code, the tool-call guard sends commands that print account details through it; other
agents are stopped and shown the wrapped command. `install` sets a git mailmap outside
every repo, and `install` and `doctor` add the marks they find on this machine.
