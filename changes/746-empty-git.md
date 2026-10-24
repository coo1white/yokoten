Fixed

An empty or partial `.git` folder no longer counts as a git checkout, so a stray `/tmp/.git` cannot make yokoten think a temp folder is a project. A folder counts only when git would use it: a `HEAD` file whose text is a `ref:` line or a commit sha, plus `objects` and `refs` folders. A worker desk whose `.git` still holds its worker mark fails closed instead (#746). Its own `yokoten-done-when` still runs on stop; the parent's is never used and the stop is never skipped.
