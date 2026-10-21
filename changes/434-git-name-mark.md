Changed

`yokoten install` now adds your git name (`git config user.name`) to the private marks by
itself, as it does your git email. It says `added your git name to the private marks (not
shown)` and never prints the name. A name that is your forge login is added once, as the
login. An address, a placeholder such as `your name` or `john doe`, and a shared name such
as `test` are left out. Unlike the login, the git name is found in a LICENSE line and an
author field too. Install no longer asks you to add your real name to the file by hand (#434).
