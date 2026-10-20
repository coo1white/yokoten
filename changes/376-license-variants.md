Fixed

`doctor` and `adopt` now count any root license file, as GitHub does (#376): LICENSE,
LICENCE, UNLICENSE or COPYING in any case, with any extension or suffix. So the dual LICENSE-MIT and
LICENSE-APACHE that most Rust projects use is a license. LICENSES.md and LICENSING.md are
not: they explain the licenses, and are no license themselves.
