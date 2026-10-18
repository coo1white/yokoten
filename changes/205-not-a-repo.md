Fixed

Outside a git repo, `init`, `update`, `doctor`, `check`, `adopt` and `bot` now say so in
one finding, write nothing, and exit 1. Before, full `doctor` printed nothing and
exited 0, `check` and `adopt` printed a raw git error, and `init` wrote its files first.
`init <dir>` now refuses a folder that does not exist instead of making it (#205).
