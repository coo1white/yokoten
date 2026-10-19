Fixed

The tool-call guard now reads through `cat` and `tee` in the middle of a pipeline. `tee` with
any files, and `cat` with no file but `-`, hand on what the command before them printed, so a
shell or `xargs git` at the end of `cat <(...) | tee f | bash` or `echo ... | cat | bash` is
read as getting the first command's text. A long chain of them is still read in linear time.
