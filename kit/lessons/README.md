# Lessons

Each folder here is a lesson from a real incident: a check (`lesson.ts`) and its test
(`lesson.test.ts`). `yokoten doctor` runs every lesson in this table against the project,
and reports what a lesson finds as a note. A note never fails doctor. To stop one, add
its id to "notNow" in yokoten.json, with the reason.

`yokoten learn --ship <id>` adds a lesson here. "Added in" is the version in
package.json when the lesson shipped.

| Lesson | Incident | Added in |
|---|---|---|
| incident-138 | https://github.com/yokoten-labs/yokoten/issues/138 | 0.1.0 |
