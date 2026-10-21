Fixed

`yokoten init` now writes a `.gitignore` with the dependency folders of the project, such as `node_modules/`, and adds only missing lines. `yokoten check` now gives one finding for a staged dependency folder, with the `git rm -r --cached` command and the `.gitignore` line (#521).
