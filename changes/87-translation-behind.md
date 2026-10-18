Added

`yokoten check` notes a translation that is behind its English source. Line 1 of the translation names the source and the git blob it was translated from: `<!-- source: docs/guide.md blob <sha> -->`. A note never fails CI; `"translations": { "fail": true }` in `yokoten.json` makes it fail (#87).
