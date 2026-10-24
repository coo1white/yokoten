Fixed

The Gitea adapter now reads Gitea's own repository fields, so doctor judges the merge
settings on a real server. A tag pattern must cover a patch release to count. A missing
code-owner field is "can't check", not off. A 404 from a later list says which API is
missing, not that the repo is missing (#849).
