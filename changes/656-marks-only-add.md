Security

`YOKOTEN_PRIVATE_MARKS` can no longer turn the privacy check off. Before, it replaced your private-marks file, so pointing it at an empty file left no marks to check. Now yokoten reads both your own file in `~/.config/yokoten` and the file the setting names, and checks for every mark in them. When your own file is there but can't be read, the commit check stops, whatever the setting says. The file that lets a mark through in one repo, `private-marks-allow.json`, is now read only from `~/.config/yokoten`, so the setting can't bring its own (#656).
