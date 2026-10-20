Added

The tool-call guard runs the privacy check on text an agent posts with `gh`: issues,
pull requests, comments, reviews, release notes and `gh api` fields, also through
`yokoten bot -- gh`. A personal email address, an IP address, a private mark or a
secret stops the command, with the same fix as the commit check (#391).
