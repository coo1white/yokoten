Added

`yokoten marks` for more control (#434). Alone, it counts your marks by kind, never the
values. `yokoten marks add` and `yokoten marks remove` read one mark, typed with no echo or
piped in, never from the command line. `yokoten marks off git-name` (or `git-email`,
`forge-login`) stops install adding that kind and removes the marks it added for it;
`yokoten marks on git-name` brings the default back. Marks you added yourself are never
touched.
