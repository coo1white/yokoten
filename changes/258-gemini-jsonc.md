Fixed

A Gemini CLI `settings.json` with `//` or `/* */` comments is no longer called unreadable.
Gemini CLI allows comments in that file (not trailing commas), and yokoten now reads it the
same way. Since rewriting the file would drop the comments, `install` and `init` leave it as
it was and print the exact hooks to add under `hooks` by hand, then exit 1 until they are
there; `doctor` gives the same hooks on one line. A commented file that already has the
hooks is ok, and is not touched (#258).
