Added

Full `doctor` notes `yokoten-*` folders older than a day in the temp folder (#400).
It gives their count and size, and prints the `find` command that removes them. Doctor
never deletes them. yokoten's own tests now remove each temp folder when the test ends,
also when it fails, so a test run leaves none behind.
