Security

The guard now sends `git log` and `git show` with any format through `yokoten redact`,
so `git log --format=%an` or `--pretty=format:%ae` no longer shows your name or email
(#413). The same holds for `git shortlog -sne`, `git blame -e`, `git for-each-ref` and
`git cat-file -p`. A format in quotes, such as `--format='%an <%ae>'`, counts as one plain
command. As before, only a single plain read is rewritten.
