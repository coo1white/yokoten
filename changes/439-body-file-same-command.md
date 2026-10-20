Fixed

The command guard now reads a body file that the same command writes, in one shape: the whole command is `cat > body.md <<'EOF' && gh issue create --body-file body.md`, then the body and `EOF`. It checks the heredoc, and the file already on disk too. In any other shape, it refuses a body file that another command beside gh may change; commands that write no file, such as assignments, `export`, `cd`, or a `gh … view` or `git status`, don't count. The refusal now says why: the guard runs before the command, so write the file in one command and post it in the next (#439).
