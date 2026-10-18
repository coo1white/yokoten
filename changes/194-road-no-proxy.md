Internal

The road test that calls a fake model API on this machine now sets `NO_PROXY` and
`no_proxy` while it runs, so it passes when the shell uses a proxy (#194).
