Fixed

`yokoten bot` now checks the title in every spelling gh takes for creating or editing an
issue or a pull request: `gh issue new` and `gh pr new`, and a repo option or any other
option before the noun or the verb, such as `gh issue -R o/r create` or
`gh --repo o/r pr create`. Before, these ran with the title unchecked.
