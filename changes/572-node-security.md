Security

yokoten now needs Node 22.23.4 or later (24.22.1 on Node 24, 26.12.1 on Node 26). Older releases, 22.18 to 22.23.3 included, still run yokoten, but they have the security holes that Node fixed on 2026-10-21, among them TLS hostname checks that the calls to GitHub rely on. npm warns about them at install, and `yokoten doctor` notes an unfixed Node with the version to upgrade to. The kit workflows and the GitHub Action set up `^22.23.4` (#572).
