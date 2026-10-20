Added

yokoten guards Grok CLI (`grok`) (#407). `init` writes `.grok/hooks/yokoten.json` with the tool-call guard and the stop check.
`init` then says how to turn the hooks on: Grok runs a project's hooks only after you type `/hooks-trust`. yokoten never trusts a folder for you.
A refusal reaches the model with its whole reason. A command that prints your name or email runs through `yokoten redact`.
Grok also runs Claude Code's hooks. There yokoten's Claude Code hook exits at once, so each call starts the guard only once.
`install` adds the command guard to `~/.grok/hooks/yokoten.json` when `~/.grok` exists.
`doctor` notes missing or old Grok hooks, and a folder Grok does not trust yet.
Checked with a real run of Grok CLI 1.0.52: it stopped `git push --tags` and ran `ls`.
