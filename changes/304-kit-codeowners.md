Added

`init` writes `.github/CODEOWNERS` for every default lead-only path, so the list the guard
keeps on the machine also has a side on the server: `check --pr` wants `tier: A` for a
change there, and with "Require review from Code Owners" on, GitHub asks the owner to
review. The owner is the account in a GitHub `origin` remote; without one the file has a
placeholder, and `doctor`'s `codeowners` step stays to do until you put your handle in.
A CODEOWNERS file the project already has is kept as it is (#304).
