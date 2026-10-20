Fixed

`doctor` reads a workflow with a very long `run:` or `uses:` line in linear time (#322).
It now reads a command one word at a time, not with a regex that repeats over the line.
Before, a 500,000-character line could take minutes, or throw a RangeError.
If a line is still too long to read, the step is "can't check", and doctor goes on.
