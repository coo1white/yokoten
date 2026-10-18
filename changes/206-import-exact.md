Fixed

Only an exact `@AGENTS.md` import (or `@../AGENTS.md` from `.claude/`) now counts.
Before, `@AGENTS.md.bak` and a Markdown link to `AGENTS.md` counted. Claude Code loads
neither, so doctor said the rules were done when the session did not read them. `init`
now adds the import to such a file and keeps its lines. The import goes after one blank
line, with the line ending most of the file uses (#206).
