Fixed

`scripts/split-tests.ts` no longer stops on a test that imports a script. A relative import of
any file in the repo outside `test/` (`../scripts/…` as well as `../src/…`) gets one more `../`
per folder deeper, and so does the path in `import('../…')`. A test that imports a script gets
that script in its file's header. The board sync test (PR #190) goes to
`test/host/github/board.test.ts`, because `test/` already holds 7 entries. An import it cannot
place (a package, a file in `test/`, a file that is not there) still stops it, now with a list
of all of them. `--from <dir>` reads a fixture's tests, for the script's own test (#152).
