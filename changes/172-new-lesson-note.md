Added

The first time a project's full `yokoten doctor` runs a kit lesson, it says so once, even when the lesson finds no problem: `new lesson: incident-138 (<what>); doctor now runs it in this project`. After that, a lesson shows only its own line. Doctor keeps the lessons it has seen in `.git/yokoten/state.json`, so the file is never committed; a missing or broken file counts as empty. A session writes nothing, and "notNow" silences the note too. `doctor --json` marks a new lesson with `isNew: true` (#172).
