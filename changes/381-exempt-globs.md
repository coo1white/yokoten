Added

`layout.exempt` in yokoten.json takes globs, so one entry such as `crates/*/tests/data`
covers every crate of a Rust workspace (#381). In a glob, `*` is one folder and `**` is any
number of folders; no other character is special. `check` and `doctor` note a glob that
matches no folder. The guide names a second kind of folder that may grow besides a log: a
third-party fixture set kept under its upstream names, with its `NOTICE` beside it. The
layout message no longer calls every exempt folder a log.
