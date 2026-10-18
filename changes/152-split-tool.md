Internal

`scripts/split-tests.ts` splits `test/` into one file per `src/` module, by layer, so parallel branches stop conflicting in the shared import blocks. It places each test by its name prefix from a table and stops on a prefix with no row. `--dry-run` prints the plan and `--out <dir>` writes the tree elsewhere to check it. The split itself runs later, on a quiet main (#152).
