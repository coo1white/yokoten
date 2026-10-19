Fixed

With `--json`, a usage error (an unknown option, options that can't go together, an extra
argument, an unknown `--agent`) and an unexpected error now print
`{ command, ok: false, error }` on stdout, with exit 1, on `check`, `doctor`, `hook`,
`explain` and `adopt`. Before, stdout was empty, so a script could not tell a usage error
from a crash. The message still goes to stderr. The guide now lists `adopt` among the
`--json` commands (#280).
