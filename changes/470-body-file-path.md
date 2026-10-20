Fixed

Before a post, the privacy check now reads the same body file that gh gets. A path that starts with `~` is refused when HOME is unset, empty or not a full path. The fix it gives is to name the full path. `~name` is always refused, because bash would read a home the guard cannot see. A path with `..` now goes up from the real folder when the working folder or home is a symlink, as the system does (#470).
