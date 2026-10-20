Changed

A pull request that changes only docs runs a short CI (#438). The kit's `yokoten.yml` has a
new `changes` job. It finds a pull request where each file is under `docs/` or `changes/`,
or is a `README.md` or `CHANGELOG.md`. Your own jobs can skip such a pull request with two
lines, shown in the file, and `ci` counts that skip as green. A push to main, or a file list
that can't be read, runs every job. `init` writes this workflow into a project that has no
`yokoten.yml`. It keeps a file that is already there, so copy the `changes` job and the new
`ci` rule into yours.
