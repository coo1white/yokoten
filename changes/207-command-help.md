Added

Every command prints its own help with `--help` or `-h`: what it does, its options and
one example, with exit 0. `yokoten help <command>` does the same, and `-v` is
`--version`. A typo in a command or an option gets the closest name: `yokoten docter`
asks `Did you mean "doctor"?`. Before, `--help` was an unknown option, and `bot --help`
asked for the bot setup. `bot -- gh --help` still runs `gh --help` (#207).
