Fixed

An empty or partial `.git` folder no longer counts as a git checkout, so a stray `/tmp/.git` cannot make yokoten think a temp folder is a project. A worker desk whose `.git` still holds its worker mark fails closed instead (#746).
