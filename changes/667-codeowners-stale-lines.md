Fixed

`yokoten check` and full `doctor` report a CODEOWNERS line whose path matches no file. A moved or renamed owned path no longer loses its owner review without a word (#667). A line with a class that cannot compile, such as `[z-a]`, is reported like any other stale line instead of stopping the whole check. A backslash before a glob keeps it literal, as on GitHub: `\*` names only the file called `*`.
