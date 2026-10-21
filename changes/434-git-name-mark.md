Changed

`yokoten install` now adds your git name (`git config user.name`) to the private marks by
itself, as it does your git email. It says `added your git name to the private marks (not
shown)` and never prints the name. A name that is your forge login is added once, as the
login, and a shared name such as `test` is left out. Like the login, the git name is fine
in a LICENSE copyright line and an author field. Install no longer asks you to add your
real name to the file by hand (#434).
