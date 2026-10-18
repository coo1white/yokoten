Internal

The weekly `outside-prs` workflow now runs `scripts/outside-prs.ts`, which a test covers. It
counts the pull requests that outside accounts opened in the last 7 days, leaves out
bots, and posts the count, the threshold of 5 a week and the pull request numbers on
issue #88. The comment no longer shows titles (#88).
