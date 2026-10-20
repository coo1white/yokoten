Added

The tool-call guard runs the privacy check on text an agent posts with `gh`: issues,
pull requests, comments, reviews, merges, closes, release notes, and `gh api` calls that
write. It reads inline text, body files, heredocs and `< file` redirects, also through
`yokoten bot -- gh`. A personal email address, an IP address, a private mark or a secret
stops the command, with the same fix as the commit check (#391). In a repo with a
`yokoten.json`, the guard also runs the bot's title check on `gh issue` and `gh pr`
`create` or `edit`. So an issue with a title CI would fail is never opened.
