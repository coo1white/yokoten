Security

A worker can no longer point `HOME`, `USERPROFILE` or `XDG_CONFIG_HOME` at another folder before `git commit`, `yokoten check`, or a shell. `env` and `export` count too. Another home has no private marks, so the check would pass (#739).

When the marks file under `$HOME` is missing, or it holds no marks, the check reads the one in the real home. The real home comes from the password database. A missing file there is not an error. A file it cannot read stops the check. A file it can read is used.

A worker cannot run a shell script from a file, such as `bash script` or `sh script`. The guard cannot read that file, so it refuses. `bash -c` stays allowed. The script text is in the command.

Unsetting `HOME` or `USERPROFILE` is refused. So is `env -u HOME` before git, gh, yokoten or a shell. A worker cannot unset those names, or `XDG_CONFIG_HOME`, before the commit check.

With no `HOME`, the check still reads the marks file in the real home.

For the lead, `HOME` before another program still passes, and so does `XDG_CONFIG_HOME`. `env -u HOME npm test` still passes.
