Fixed

`yokoten bot` fetches a missing base commit before it reads CODEOWNERS. When that commit is still missing, it tells the lead to run `git fetch origin` (#670).
