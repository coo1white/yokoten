Added

`yokoten doctor` now reads a Gitea server, so a Gitea repo walks the road with its forge steps judged instead of marked "can't check". Name a self-hosted Gitea in `yokoten.json` (`"host": "gitea"`), give the bot user a token in `GITEA_TOKEN`, and doctor reads the default branch protection, tag protection, labels, milestones and forgotten branches through Gitea's API. `gitea.com` is recognised without the key. The workflow steps also read `.gitea/workflows` on Gitea, next to `.github/workflows`. The API is read only, and only in full doctor (#505).
