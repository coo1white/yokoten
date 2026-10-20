Fixed

The command guard now checks a body file that the same command writes with a heredoc: `cat > body.md <<'EOF' … EOF`, then `gh issue create --body-file body.md`. It also fills in a variable set earlier in the command, as in `S=/path; … --body-file $S/x.md`. When it still can't tell what the file will hold, the guard refuses as before, and now says why: the file doesn't exist yet when the guard runs, so write it in one command and post it in the next (#439).
