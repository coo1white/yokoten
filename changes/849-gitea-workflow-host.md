Fixed

The tests, CI and titles steps read `.gitea/workflows` on every host, so a workflow the
host never runs made them look done: on GitHub, and on GitLab or a host with no adapter
too. They now read the folder the host runs: only `.github/workflows`, and both folders
on Gitea (#849).
