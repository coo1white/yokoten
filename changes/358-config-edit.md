Fixed

The guard now refuses `git config --edit` in every scope (#358). An editor can rewrite core.hooksPath, and the guard cannot see what it writes. It also reads a shortened option, such as `--unset-a`, as git does. Setting an include, which reads another config file, is refused too.
