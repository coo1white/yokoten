Fixed

The guard no longer reads a quoted `~` after `cd` as your home folder. Bash keeps `cd "~/x"` as a folder named `~`, so the guard now treats where that `cd` goes as unknown. A worker that writes a lead-only file after such a `cd` is stopped again (#465).
