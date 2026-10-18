Internal

The road test that calls a fake model API on this machine now sets `NO_PROXY` and
`no_proxy` while it runs, so it passes when the shell uses a proxy. The CLI tests' clean
environment sets them too, so a child that calls a fake server on this machine never
goes through a proxy (#194).
