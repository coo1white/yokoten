Fixed

A merge to `main` no longer cancels the run before it, so every commit on `main` is tested on its own. Only a push to a pull request cancels the older run (#660).
