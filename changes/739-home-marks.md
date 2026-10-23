Security

A worker can no longer point `HOME`, `USERPROFILE` or `XDG_CONFIG_HOME` at another folder before `git commit`, `yokoten check`, or a shell. `env` and `export` count too. Another home has no private marks, so the check would pass (#739). The commit check now stops when its marks file is missing and the real home, from the password database, has one it cannot read. For the lead, `HOME` before another program still passes, and so does `XDG_CONFIG_HOME`.
