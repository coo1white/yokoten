Added

`doctor` notes machine problems that stop every agent session unseen (record 0012). It
notes a disk low on space: under 20 GB and under 10% of the disk, or below
`YOKOTEN_MIN_FREE_GB`. In WSL, full `doctor` also reads the Windows drive that holds the
Linux disk file, and prints the commands that let that file shrink. A session repeats
that reading without running a program. Full `doctor` also notes a Claude Code temp
folder that another user owns, and prints the `sudo rm -rf` command to run. These are
notes: they never change the exit code.
