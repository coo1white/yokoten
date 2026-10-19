Fixed

`scripts/split-tests.ts` no longer stops on a test that imports a script. A relative import of
any file in the repo outside `test/` (`../scripts/…` as well as `../src/…`) gets one more `../`
per folder deeper, and so does the path in `import('../…')`. A file with no `src/` module of its
own, whose tests import a script, names that script in its header. The board sync tests
(PR #190) go to `test/host/github.test.ts`, next to the host. An import it cannot
place (a package, a file in `test/`, a file that is not there) still stops it, now with a list
of all of them. `--from <dir>` reads a fixture's tests, for the script's own test (#152).
