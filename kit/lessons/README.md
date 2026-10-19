# Lessons

Each lesson here is from a real incident: a folder with a check (`lesson.ts`) and its test
(`lesson.test.ts`). `yokoten doctor` runs every lesson in this table against the project,
and reports what a lesson finds as a note. A note never fails doctor. To stop one, add
its id to "notNow" in yokoten.json, with the reason.

`yokoten learn --ship <id>` adds a lesson here. "Folder" is where it is, in numbered
groups so no folder holds more than 7 entries: a group takes 5 lessons and 2 more groups.
"Added in" is the version in package.json when the lesson shipped.

| Lesson | Folder | Incident | Added in |
|---|---|---|---|
| incident-138 | 1/incident-138 | https://github.com/yokoten-labs/yokoten/issues/138 | 0.1.0 |
