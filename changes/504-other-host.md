Changed

`doctor` reads the code host from the `origin` remote. Some steps only the host can judge: `tests`, `ci`, `labels`, `milestone`, `titles`, `codeowners`, `bot`, `review` and the server steps. On a host other than GitHub, such as Gitea or GitLab, these are now "can't check". Each says what it asks, so you can set it up by hand, and none holds the stage. doctor prints no GitHub menu or command there, and never prints a self-hosted server's name. On GitHub nothing changes (#504).
