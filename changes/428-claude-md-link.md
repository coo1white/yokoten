Fixed

`init` no longer makes AGENTS.md import itself when CLAUDE.md is a link to it (#428).
A CLAUDE.md, at the root or in `.claude/`, that links to AGENTS.md already reads the rules: `init` leaves it as it is, and `doctor` sees no gap.
A CLAUDE.md that links to another file is never written through: `init` and `doctor` say where it points and what line to add.
