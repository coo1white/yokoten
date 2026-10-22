Added

`yokoten bot` refuses `gh pr merge` of a tier A pull request whose Approve is on an
older commit. The merge goes on when the Approve is on the head. A clean merge of
the base branch also passes, when the pull request's own diff is the same as at the
Approve. `gh pr status` through the bot shows the same
check for every open pull request (#612).
