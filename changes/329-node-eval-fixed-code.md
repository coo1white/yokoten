Internal

An architecture test now catches code built from values and run with `node -e`, `--eval`,
`-p` or `--print` (#329). CodeQL warns about it as js/bad-code-sanitization. The code stays
fixed text; values go in on stdin or as arguments.
