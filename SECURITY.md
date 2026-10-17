# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately: the repo's **Security** tab →
**Report a vulnerability**. Only the owner sees the report.

It helps to include what you ran, what happened, what you expected, and the version
(`node bin/yokoten.ts version`). You'll usually get an answer within a week.

## What counts

yokoten runs as a hook on your machine and reads the files in your repo. A
vulnerability is anything that lets a repo, a file, or a tool call:

- run code you did not expect when a hook, the commit check or `doctor` runs;
- make yokoten print a line of your private-marks file, or send it anywhere;
- make `init` or `install` write outside the project, `~/.claude`, or yokoten's own
  folders.

Not a vulnerability: getting a command past the tool-call guard by building it in
pieces. The guard reads command text and catches mistakes, not attacks; the lock is on
the server ([the guide](docs/guide.md#what-it-doesnt-do) says so).

## Supported versions

Before 1.0, only the latest release gets fixes.
