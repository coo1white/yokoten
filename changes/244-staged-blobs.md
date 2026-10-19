Fixed

`check` now reads the bytes git stores, not files by path. `check --staged` takes each
staged file's mode and blob id from git and reads the blobs in one batch. A repo with a
submodule, a submodule pointer bump, and a file named like `2:notes.md` no longer crash
the commit check. A symlink replaced by a regular file is now checked for privacy. A
file counts as binary when it has a NUL in its first 8000 bytes, as git decides it, so a
text lockfile marked `-diff` or `binary` in `.gitattributes` is no longer refused. The
tree `check` and the stop hook read a symlink's link text and never follow it, so a link
out of the repo is not flagged for its target, and a link to `/dev/zero` no longer runs
the check out of memory. The staged blobs are read in batches of at most 64 MiB, so a
commit of several large images no longer fails; a file over 64 MiB is read only for
its first 8000 bytes, to tell binary, and is not scanned for privacy. A staged entry
whose blob is missing from the object store is now refused, not passed as empty. The
privacy check uses the same binary rule as the binary check, so a text file with a NUL
after its first 8000 bytes is scanned (#244).
