Fixed

The tool-call guard now reads what a command prints into a pipe that ends in a shell or in
`xargs git`, as that shell or git would get it. What a substitution prints counts:
`cat <(...) | bash` and `echo "$(...)" | bash` read the inside's output as commands. A
`printf` whose format has only `%s` and `%b` is filled in with its arguments first, so
`printf '%s\n' push --force | xargs git` is read as `git push --force`; with a harder format
the guard reads the arguments as plain words. A `{ }` group piped to `xargs git` hands what it
prints to git, too. The reads stay linear in the length of the command.
