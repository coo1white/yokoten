Security

The guard now sends `git log` and `git show` with any format through `yokoten redact`,
so `git log --format=%an` or `--pretty=format:%ae` no longer shows your name or email
(#413). The same holds for `git blame -e`, `git for-each-ref`, `git cat-file -p`, and
`git shortlog -sne` with a revision such as `HEAD`. A format in plain quotes, such as
`--format='%an <%ae>'`, counts as one plain command. As before, only a single plain read
is rewritten. A command with an unclosed quote, or a `$` inside double quotes, is not.
