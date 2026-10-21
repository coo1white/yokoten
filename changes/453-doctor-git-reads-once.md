Changed

`yokoten doctor` and `yokoten init` start fewer git processes: each git question is asked once per run, and the git settings are read in one call. Full doctor in a new repo starts 13 programs in place of 31, a session start 8 in place of 11 (#453).
