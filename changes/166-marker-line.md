Fixed

Branches that update a translation with its English no longer conflict on line 1. The marker now names only the English file, `<!-- source: docs/guide.md -->`, and never changes. A translation is current when the last commit that changed it, any line, is the same as or later than the last commit that changed the English. A typo fix to the translation also counts, so it can hide an English change; the guide says how to avoid that. The older marker with a blob still works (#166).
