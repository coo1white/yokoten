Added

The tool-call guard stops a worker's shell writes to lead-only files, not only its edits
(#402). It reads redirects, `sed -i`, `perl -i`, `tee`, `cp`, `mv`, `install`, `ln`,
`dd`, `truncate`, `rm`, and git's `checkout`, `restore`, `rm`, `mv` and `apply`. It also
stops a worker's `git commit` that would commit a lead-only file. This covers a Claude
Code subagent such as `yokoten:worker`, which has no `YOKOTEN_ROLE` for the commit check
to read. Reads such as `cat` and `grep` pass, and the lead is never stopped. As for
edits, this holds only in a repo that uses yokoten. When a brief asks for a change to a
lead-only file, the lead starts the worker with `YOKOTEN_LEAD_ONLY_OK=<path>,<path>`.
The guard and the commit check then let those paths through. At session start, `doctor`
tells a session with `YOKOTEN_ROLE=worker` "this session is a worker: lead-only files are
guarded"; the lead hears nothing. `doctor`'s self-test now checks a shell write from
`yokoten:worker`.
The guard also reads `>|` as a redirect now. Before, it read it as a pipe.
